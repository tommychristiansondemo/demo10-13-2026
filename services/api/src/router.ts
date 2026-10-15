// Transport-agnostic API routes (adapted to Lambda response streaming in handler.ts and to node:http in local-server.ts).
import { runAnalysis } from './agent.js';
import { getActiveModel, getCatalog, getSelection, saveSelection, selectionHistory } from './appconfig.js';
import { AuthError, authenticate, type User } from './auth.js';
import { config } from './config.js';
import type { ServerId, StreamEvent } from './events.js';
import { closeAll, openConnections } from './mcp.js';
import { decide as decideModel, rankModels, validateWeights, type ModelSelection } from './model-routing.js';
import { log, metric } from './observability.js';
import { ConflictError, decide, getRun, listRuns, putRun } from './store.js';

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
}

export interface ApiResponse {
  json(status: number, body: unknown): Promise<void>;
  /** Start an NDJSON stream; returns a writer for one JSON object per line. */
  ndjson(): { write(obj: unknown): void; end(): Promise<void> };
}

const CLAIM_ID = /^CLM-\d{5}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function route(req: ApiRequest, res: ApiResponse): Promise<void> {
  const started = Date.now();
  const parts = req.path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  let user: User | undefined;
  try {
    if (req.method === 'GET' && parts[0] === 'health') return await res.json(200, { ok: true, modelId: (await getActiveModel()).modelId });

    user = await authenticate(req.headers['x-auth-token']);
    const [a, id, b, runId, c] = parts;

    if (req.method === 'GET' && a === 'me') return await res.json(200, user);
    if (req.method === 'GET' && a === 'models' && !id) return await res.json(200, await modelsView());
    if (req.method === 'POST' && a === 'models' && id === 'evaluate') return await res.json(200, await evaluateModels(user, req.body));
    if (req.method === 'GET' && a === 'mcp' && id === 'servers') return await res.json(200, await describeServers());
    if (a === 'claims' && !id && req.method === 'GET') return await res.json(200, await listClaims());

    if (a === 'claims' && id) {
      if (!CLAIM_ID.test(id)) throw new HttpError(400, 'Invalid claim id');
      if (req.method === 'GET' && !b) return await res.json(200, await claimDetail(id));
      if (req.method === 'POST' && b === 'analyze') {
        if (!user.isAnalyst) throw new HttpError(403, 'Only claims analysts can request an AI analysis');
        return await analyze(id, user, res);
      }
      if (req.method === 'GET' && b === 'runs' && !runId) return await res.json(200, { runs: (await listRuns(id)).map(summarize) });
      if (req.method === 'GET' && b === 'runs' && runId && !c) {
        const run = await getRun(id, runId);
        if (!run) throw new HttpError(404, 'Run not found');
        return await res.json(200, run);
      }
      if (req.method === 'POST' && b === 'runs' && runId && c === 'decision') {
        if (!user.isSupervisor) throw new HttpError(403, 'Only claims supervisors can approve or reject recommendations');
        const body = JSON.parse(req.body || '{}') as { decision?: string; comment?: string };
        const decision = body.decision?.toUpperCase();
        if (decision !== 'APPROVED' && decision !== 'REJECTED' && decision !== 'RETURNED') {
          throw new HttpError(400, 'decision must be APPROVED, REJECTED or RETURNED');
        }
        const comment = String(body.comment ?? '').slice(0, 1000);
        if (decision !== 'APPROVED' && !comment.trim()) throw new HttpError(400, 'A comment is required to reject or return');
        const run = await decide(id, runId, { decision, comment, by: user.username, at: new Date().toISOString() });
        log('audit_decision', { claimId: id, runId, decision, by: user.username, comment });
        return await res.json(200, run);
      }
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof AuthError ? 401 : err instanceof ConflictError ? 409 : 500;
    if (status === 500) log('api_error', { path: req.path, error: (err as Error).stack });
    await res.json(status, { error: status === 500 ? 'Internal error' : (err as Error).message });
  } finally {
    log('api_request', { method: req.method, path: req.path, user: user?.username, durationMs: Date.now() - started });
  }
}

async function listClaims() {
  const conns = openConnections('list');
  try {
    const r = await conns.get('claims_policy')!.callTool('list_claims', {});
    if (!r.ok) throw new Error(`list_claims failed: ${JSON.stringify(r.data)}`);
    return { ...(r.data as object), via: { server: 'claims_policy', tool: 'list_claims', latencyMs: r.latencyMs } };
  } finally {
    await closeAll(conns);
  }
}

/** The claim page is assembled from deterministic MCP tool calls - the same tools the agent uses. */
async function claimDetail(claimId: string) {
  const conns = openConnections('detail');
  const plan: [Exclude<ServerId, 'knowledge_base'>, string, string][] = [
    ['claims_policy', 'get_claim', 'claim'],
    ['claims_policy', 'get_policy_coverage', 'coverage'],
    ['claims_policy', 'get_repair_estimate', 'estimate'],
    ['claims_policy', 'get_claim_status', 'status'],
    ['damage_repair', 'get_damage_assessment', 'damage'],
    ['damage_repair', 'get_severity_indicators', 'severity'],
  ];
  try {
    const results = await Promise.all(plan.map(([s, tool]) => conns.get(s)!.callTool(tool, { claim_id: claimId })));
    const notFound = results[0];
    if (!notFound.ok) throw new HttpError(404, typeof notFound.data === 'string' ? notFound.data : 'Claim not found');
    const out: Record<string, unknown> = { claimId, via: [] as unknown[] };
    plan.forEach(([server, tool, key], i) => {
      out[key] = results[i].ok ? results[i].data : { error: results[i].data };
      (out.via as unknown[]).push({ server, tool, ok: results[i].ok, latencyMs: results[i].latencyMs });
    });
    return out;
  } finally {
    await closeAll(conns);
  }
}

/** Everything the Model routing page shows: the catalog, the configured preferences, the ranking under them, and history. */
async function modelsView() {
  const [catalog, selection, history] = await Promise.all([getCatalog(), getSelection(), selectionHistory().catch(() => [])]);
  const ranking = rankModels(catalog, selection.weights, selection.qualityFloor);
  return { source: config.appConfig.applicationId ? 'AWS AppConfig' : 'bundled default', selection, catalog, ranking, history };
}

/** A student moved the sliders and clicked "Evaluate & apply": store the preferences in AppConfig, and switch models if warranted. */
async function evaluateModels(user: User, body?: string) {
  let weights;
  try {
    weights = validateWeights((JSON.parse(body || '{}') as { weights?: unknown }).weights);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const [catalog, current] = await Promise.all([getCatalog(), getSelection()]);
  const ranking = rankModels(catalog, weights, current.qualityFloor);
  const decision = decideModel(ranking, current.activeModel, current.switchMargin);
  const unchanged = !decision.switch && ['quality', 'cost', 'latency'].every((c) => current.weights[c as 'quality'] === weights[c as 'quality']);
  const name = (k: string) => catalog.models.find((m) => m.key === k)?.name ?? k;
  const next: ModelSelection = { ...current, weights, activeModel: decision.to, updatedBy: user.username, updatedAt: new Date().toISOString(), reason: decision.reason };
  const summary = `${user.username}: quality ${weights.quality}% / cost ${weights.cost}% / latency ${weights.latency}% -> ` +
    (decision.switch ? `switched ${name(decision.from)} to ${name(decision.to)}` : `kept ${name(decision.from)}`);
  const deployment = unchanged ? undefined : await saveSelection(next, `${summary}. ${decision.reason}`);
  log('model_selection', { by: user.username, weights, previous: current.weights, decision, ranking: ranking.map((r) => ({ rank: r.rank, key: r.key, total: r.total })), deployment });
  if (decision.switch) metric('ModelSwitch', 1, 'Count', { To: decision.to });
  return { decision, summary, deployment: deployment ?? null, unchanged, selection: unchanged ? current : next, ranking };
}

async function describeServers() {
  const conns = openConnections('describe');
  try {
    return {
      region: config.region,
      servers: await Promise.all(
        [...conns.values()].map(async (conn) => {
          const t0 = Date.now();
          try {
            const tools = await conn.listTools();
            return { id: conn.server.id, label: conn.server.label, runtimeArn: conn.server.runtimeArn ?? null, endpoint: conn.endpoint, transport: 'streamable-http', auth: conn.server.runtimeArn ? 'AWS IAM (SigV4)' : 'none (local)', ok: true, latencyMs: Date.now() - t0, tools };
          } catch (err) {
            return { id: conn.server.id, label: conn.server.label, runtimeArn: conn.server.runtimeArn ?? null, ok: false, error: (err as Error).message, latencyMs: Date.now() - t0, tools: [] };
          }
        }),
      ),
    };
  } finally {
    await closeAll(conns);
  }
}

async function analyze(claimId: string, user: User, res: ApiResponse) {
  const out = res.ndjson();
  // Heartbeats keep CloudFront's origin read timeout from firing while the model is thinking.
  const ping = setInterval(() => out.write({ type: 'ping', t: Date.now() } satisfies StreamEvent), 10_000);
  try {
    const run = await runAnalysis({ claimId, requestedBy: user.username, emit: (e) => out.write(e) });
    await putRun(run);
    log('audit_analysis', { claimId, runId: run.runId, by: user.username, status: run.status, durationMs: run.durationMs, disposition: run.recommendation?.disposition });
    out.write({ type: 'run_completed', run } satisfies StreamEvent);
  } catch (err) {
    out.write({ type: 'error', message: (err as Error).message } satisfies StreamEvent);
  } finally {
    clearInterval(ping);
    await out.end();
  }
}

function summarize(r: Awaited<ReturnType<typeof listRuns>>[number]) {
  return {
    runId: r.runId,
    createdAt: r.createdAt,
    requestedBy: r.requestedBy,
    status: r.status,
    disposition: r.recommendation?.disposition,
    headline: r.recommendation?.headline,
    decision: r.decision,
    durationMs: r.durationMs,
  };
}
