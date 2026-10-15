// Costs, two ways:
//  1. Per LLM call: every llm_call log line (both apps) carries token usage; cost = tokens x AWS list price (from the AppConfig
//     model catalog). Exact to the call, available seconds after the call.
//  2. AWS Cost Explorer: what AWS actually billed the account, by service and day (lags ~24 h; Cost Explorer API calls cost
//     $0.01 each, so results are cached for an hour per Lambda instance).
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand, type GetCostAndUsageCommandInput } from '@aws-sdk/client-cost-explorer';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { getCatalog, getSelection, selectionHistory } from '../../api/src/appconfig.js';
import { costUsd, rankModels, type ModelEntry } from '../../api/src/model-routing.js';
import { config } from './config.js';
import { redact } from './redact.js';

const logs = new CloudWatchLogsClient({});
const ce = new CostExplorerClient({ region: 'us-east-1' }); // Cost Explorer is a global service served from us-east-1
export const PROJECT_TAG = { key: 'project', value: 'claims-intelligence-workbench' };

// ---------------------------------------------------------------- model routing (AppConfig)
export async function getModelRouting() {
  const [catalog, selection, history] = await Promise.all([getCatalog(), getSelection(), selectionHistory(8).catch(() => [])]);
  const active = catalog.models.find((m) => m.key === selection.activeModel);
  return {
    source: 'AWS AppConfig (application claims-workbench, environment live; profiles model-catalog and model-selection)',
    activeModel: active ? { key: active.key, name: active.name, provider: active.provider, modelId: active.modelId } : selection.activeModel,
    selection,
    ranking: rankModels(catalog, selection.weights, selection.qualityFloor),
    catalog: catalog.models.map(({ key, name, provider, modelId, strengths, tradeoffs, invocation, pricing, benchmark }) => ({ key, name, provider, modelId, strengths, tradeoffs, invocation, pricing, benchmark })),
    catalogDescription: catalog.description,
    recentChanges: history,
  };
}

// ---------------------------------------------------------------- per-call LLM costs (CloudWatch Logs)
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}
type CallLine = Record<string, unknown> & { app?: string; runId?: string; conversationId?: string; claimId?: string; turn?: number; modelId?: string; modelName?: string; latencyMs?: number; usage?: Usage; costUsd?: number; ts?: string };

const round = (x: number, d = 6) => Number(x.toFixed(d));

export async function getLlmCosts(args: { app?: 'claims-workbench' | 'class-insights' | 'all'; minutes?: number; limit?: number }) {
  const app = args.app ?? 'all';
  const minutes = Math.min(Math.max(args.minutes ?? 7 * 24 * 60, 5), 14 * 24 * 60);
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
  const catalog = await getCatalog();
  const byModelId = new Map<string, ModelEntry>(catalog.models.map((m) => [m.modelId, m]));
  const ids = [...(app !== 'class-insights' ? ['workbench-api'] : []), ...(app !== 'claims-workbench' ? ['insights-chat'] : [])];

  const lines: CallLine[] = [];
  for (const id of ids) {
    const s = config.logSources.find((x) => x.id === id);
    if (!s) continue;
    let nextToken: string | undefined;
    do {
      const r = await logs.send(new FilterLogEventsCommand({ logGroupName: s.logGroup, startTime: Date.now() - minutes * 60_000, filterPattern: '{ $.log_type = "llm_call" }', nextToken, limit: 1000 }));
      for (const e of r.events ?? []) {
        const m = e.message ?? '';
        try {
          lines.push({ ts: new Date(e.timestamp!).toISOString(), ...(JSON.parse(m.slice(m.indexOf('{'))) as CallLine) });
        } catch {
          /* not JSON */
        }
      }
      nextToken = r.nextToken;
    } while (nextToken && lines.length < 20_000);
  }

  const calls = lines.map((l) => {
    const u = l.usage ?? {};
    const model = byModelId.get(l.modelId ?? '');
    const tokens = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cacheReadInputTokens ?? 0, cacheWriteTokens: u.cacheWriteInputTokens ?? 0 };
    // Older lines (before per-call costs were logged) are priced now from the same catalog prices.
    const cost = typeof l.costUsd === 'number' ? l.costUsd : model ? costUsd(model, tokens) : null;
    return {
      // Lines from the first day predate the app field; a claim id means the Workbench agent.
      ts: l.ts!, app: String(l.app ?? (l.claimId ? 'claims-workbench' : 'class-insights')), runId: String(l.runId ?? ''), claimId: l.claimId ?? null, conversationId: l.conversationId ?? null,
      turn: Number(l.turn ?? 0), modelId: l.modelId ?? '', modelName: l.modelName ?? model?.name ?? l.modelId ?? 'unknown',
      latencyMs: Number(l.latencyMs ?? 0), ...tokens, costUsd: cost === null ? null : round(cost), costSource: !l.usage || tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens === 0 ? 'no token usage in this log line (logged before usage was recorded)' : typeof l.costUsd === 'number' ? 'logged at call time' : model ? 'computed from catalog prices' : 'unpriced model',
    };
  });
  calls.sort((a, b) => b.ts.localeCompare(a.ts));

  const sum = (xs: typeof calls) => ({
    calls: xs.length,
    costUsd: round(xs.reduce((s, c) => s + (c.costUsd ?? 0), 0), 4),
    inputTokens: xs.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: xs.reduce((s, c) => s + c.outputTokens, 0),
    cacheReadTokens: xs.reduce((s, c) => s + c.cacheReadTokens, 0),
    avgLatencyMs: xs.length ? Math.round(xs.reduce((s, c) => s + c.latencyMs, 0) / xs.length) : 0,
  });
  const group = (key: (c: (typeof calls)[number]) => string) => {
    const m = new Map<string, typeof calls>();
    for (const c of calls) m.set(key(c), [...(m.get(key(c)) ?? []), c]);
    return m;
  };
  const runs = [...group((c) => `${c.app}|${c.runId}`).entries()].map(([k, xs]) => {
    const first = xs[xs.length - 1];
    return { app: k.split('|')[0], runId: k.split('|')[1], claimId: first.claimId, conversationId: first.conversationId, startedAt: first.ts, models: [...new Set(xs.map((x) => x.modelName))], ...sum(xs) };
  });
  const analyses = runs.filter((r) => r.app === 'claims-workbench');

  return redact({
    app, minutes, pricedFrom: 'AWS list prices in the AppConfig model catalog (AWS Price List API, us-east-1 on-demand)',
    totals: sum(calls),
    byApp: Object.fromEntries([...group((c) => c.app).entries()].map(([k, xs]) => [k, sum(xs)])),
    byModel: [...group((c) => c.modelName).entries()].map(([model, xs]) => ({
      model, ...sum(xs),
      analyses: new Set(xs.filter((x) => x.app === 'claims-workbench').map((x) => x.runId)).size,
      avgCostPerAnalysisUsd: (() => {
        const n = new Set(xs.filter((x) => x.app === 'claims-workbench').map((x) => x.runId)).size;
        return n ? round(xs.filter((x) => x.app === 'claims-workbench').reduce((s, c) => s + (c.costUsd ?? 0), 0) / n, 5) : null;
      })(),
    })).sort((a, b) => b.costUsd - a.costUsd),
    analyses: { count: analyses.length, avgCostUsd: analyses.length ? round(analyses.reduce((s, r) => s + r.costUsd, 0) / analyses.length, 5) : 0 },
    runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100),
    calls: calls.slice(0, limit),
    callsTruncated: calls.length > limit,
  });
}

// ---------------------------------------------------------------- AWS Cost Explorer
const LLM_SERVICE = /bedrock|claude|llama|nova|gpt-oss|mistral|anthropic/i;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const amount = (m?: Record<string, { Amount?: string }>) => Number(m?.UnblendedCost?.Amount ?? 0);
let ceCache: { at: number; value: unknown } | undefined;

export async function getCostExplorer(args: { refresh?: boolean } = {}) {
  if (ceCache && !args.refresh && Date.now() - ceCache.at < 3600_000) return { ...(ceCache.value as object), cached: true, cachedAt: new Date(ceCache.at).toISOString() };
  const now = new Date();
  const today = iso(now);
  const tomorrow = iso(new Date(now.getTime() + 86_400_000));
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthStart = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const nextMonthStart = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
  const twoWeeksAgo = iso(new Date(now.getTime() - 14 * 86_400_000));
  const q = (input: Partial<GetCostAndUsageCommandInput>) => ce.send(new GetCostAndUsageCommand({ Metrics: ['UnblendedCost'], ...input } as GetCostAndUsageCommandInput));
  const errors: string[] = [];
  const safe = async <T>(label: string, p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
      return undefined;
    }
  };

  const [monthly, daily, tagged] = await Promise.all([
    safe('monthly by service', q({ TimePeriod: { Start: lastMonthStart, End: tomorrow }, Granularity: 'MONTHLY', GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] })),
    safe('daily by service', q({ TimePeriod: { Start: twoWeeksAgo, End: tomorrow }, Granularity: 'DAILY', GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] })),
    safe('tagged', q({ TimePeriod: { Start: monthStart, End: tomorrow }, Granularity: 'MONTHLY', GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      Filter: { Tags: { Key: PROJECT_TAG.key, Values: [PROJECT_TAG.value], MatchOptions: ['EQUALS'] } } })),
  ]);
  const services = (period?: { Groups?: { Keys?: string[]; Metrics?: Record<string, { Amount?: string }> }[] }) =>
    (period?.Groups ?? []).map((g) => ({ service: g.Keys![0], usd: round(amount(g.Metrics), 2) })).filter((s) => s.usd >= 0.005).sort((a, b) => b.usd - a.usd);
  const periods = monthly?.ResultsByTime ?? [];
  const thisMonth = services(periods.find((p) => p.TimePeriod?.Start === monthStart));
  const lastMonth = services(periods.find((p) => p.TimePeriod?.Start === lastMonthStart));
  const llmServices = [...new Set([...thisMonth, ...lastMonth].map((s) => s.service).filter((s) => LLM_SERVICE.test(s)))];

  const llmByUsageType = llmServices.length
    ? await safe('LLM by usage type', q({ TimePeriod: { Start: monthStart, End: tomorrow }, Granularity: 'MONTHLY', GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
        Filter: { Dimensions: { Key: 'SERVICE', Values: llmServices } } }))
    : undefined;
  const forecast = today < iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)))
    ? await safe('forecast', ce.send(new GetCostForecastCommand({ TimePeriod: { Start: tomorrow, End: nextMonthStart }, Granularity: 'MONTHLY', Metric: 'UNBLENDED_COST' })))
    : undefined;

  const total = (xs: { usd: number }[]) => round(xs.reduce((s, x) => s + x.usd, 0), 2);
  const value = {
    generatedAt: now.toISOString(),
    scope: 'Whole AWS account (Cost Explorer, unblended cost, USD). Other class demos in the same account are included.',
    dataLag: 'Cost Explorer data is typically 8-24 hours behind; today is partial. Per-call LLM costs (from logs) are near real time.',
    monthToDate: { start: monthStart, totalUsd: total(thisMonth), llmUsd: total(thisMonth.filter((s) => LLM_SERVICE.test(s.service))), byService: thisMonth },
    lastMonth: { start: lastMonthStart, totalUsd: total(lastMonth), llmUsd: total(lastMonth.filter((s) => LLM_SERVICE.test(s.service))), byService: lastMonth },
    forecastRestOfMonthUsd: forecast?.Total?.Amount ? round(Number(forecast.Total.Amount), 2) : null,
    daily: (daily?.ResultsByTime ?? []).map((d) => {
      const g = d.Groups ?? [];
      return { date: d.TimePeriod!.Start!, totalUsd: round(g.reduce((s, x) => s + amount(x.Metrics), 0), 2), llmUsd: round(g.filter((x) => LLM_SERVICE.test(x.Keys![0])).reduce((s, x) => s + amount(x.Metrics), 0), 2) };
    }),
    llmMonthToDateByUsageType: (llmByUsageType?.ResultsByTime?.[0]?.Groups ?? [])
      .map((g) => ({ usageType: g.Keys![0], usd: round(amount(g.Metrics), 3) })).filter((x) => x.usd >= 0.001).sort((a, b) => b.usd - a.usd).slice(0, 25),
    taggedThisApp: {
      tag: `${PROJECT_TAG.key}=${PROJECT_TAG.value}`,
      note: 'Resources carry this tag (CDK). Cost allocation tags only collect data from the day they are activated (activated 2026-10-14), and Bedrock on-demand model invocations are not tagged, so LLM spend shows up under the account totals and the per-call view instead.',
      monthToDateUsd: total(services(tagged?.ResultsByTime?.[0])),
      byService: services(tagged?.ResultsByTime?.[0]),
    },
    errors,
  };
  ceCache = { at: Date.now(), value };
  return { ...value, cached: false };
}

/** Pricing for a model id from the catalog (used by the chatbot to cost its own calls). */
export async function pricingFor(modelId: string): Promise<ModelEntry | undefined> {
  return (await getCatalog()).models.find((m) => m.modelId === modelId);
}
