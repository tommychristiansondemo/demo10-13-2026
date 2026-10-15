// Read-only data sources shared by the Insights API (pages) and the Insights chatbot (tools).
// Every function returns redacted, size-bounded JSON.
import { BedrockAgentCoreControlClient, GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudFormationClient, DescribeStacksCommand, paginateListStackResources } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CognitoIdentityProviderClient, paginateListUsersInGroup } from '@aws-sdk/client-cognito-identity-provider';
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { BedrockAgentClient, GetKnowledgeBaseCommand, ListDataSourcesCommand, ListIngestionJobsCommand } from '@aws-sdk/client-bedrock-agent';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config, type LogSource } from './config.js';
import { getModelRouting } from './costs.js';
import { redact } from './redact.js';

const cfn = new CloudFormationClient({});
const logs = new CloudWatchLogsClient({});
const cw = new CloudWatchClient({});
const s3 = new S3Client({});
const lambda = new LambdaClient({});
const agentcore = new BedrockAgentCoreControlClient({});
const idp = new CognitoIdentityProviderClient({});
const bedrockAgent = new BedrockAgentClient({});

/** The Bedrock Knowledge Base (claims-handling manual): configuration, data source and the latest ingestion job. */
export async function getKnowledgeBaseInfo() {
  const id = process.env.KNOWLEDGE_BASE_ID;
  if (!id) return null;
  const kb = (await bedrockAgent.send(new GetKnowledgeBaseCommand({ knowledgeBaseId: id }))).knowledgeBase!;
  const ds = (await bedrockAgent.send(new ListDataSourcesCommand({ knowledgeBaseId: id }))).dataSourceSummaries?.[0];
  const job = ds ? (await bedrockAgent.send(new ListIngestionJobsCommand({ knowledgeBaseId: id, dataSourceId: ds.dataSourceId, sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' }, maxResults: 1 }))).ingestionJobSummaries?.[0] : undefined;
  const vec = kb.knowledgeBaseConfiguration?.vectorKnowledgeBaseConfiguration;
  return {
    id, name: kb.name, status: kb.status, description: kb.description,
    embeddingModel: vec?.embeddingModelArn?.split('/').pop(), dimensions: vec?.embeddingModelConfiguration?.bedrockEmbeddingModelConfiguration?.dimensions,
    vectorStore: kb.storageConfiguration?.type, vectorIndex: kb.storageConfiguration?.s3VectorsConfiguration?.indexArn,
    dataSource: ds ? { name: ds.name, status: ds.status } : null,
    lastIngestion: job ? { status: job.status, startedAt: job.startedAt?.toISOString(), updatedAt: job.updatedAt?.toISOString(), statistics: job.statistics } : null,
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);
const parse = (m: string): unknown => {
  const t = m.trim();
  // Lambda prefixes console.log lines with "<ts>\t<requestId>\tINFO\t"; the JSON payload follows.
  const i = t.indexOf('{');
  if (i >= 0) {
    try {
      return JSON.parse(t.slice(i));
    } catch {
      /* not JSON */
    }
  }
  return clip(t, 2000);
};
const cached = <T>(ttlMs: number, fn: () => Promise<T>) => {
  let at = 0;
  let value: Promise<T> | undefined;
  return () => {
    if (!value || Date.now() - at > ttlMs) {
      at = Date.now();
      value = fn().catch((e) => {
        value = undefined;
        throw e;
      });
    }
    return value;
  };
};

// ---------------------------------------------------------------- knowledge
export const getKnowledge = cached(30_000, async () => {
  const o = await s3.send(new GetObjectCommand({ Bucket: config.knowledgeBucket, Key: config.knowledgeKey }));
  return { bucket: config.knowledgeBucket, key: config.knowledgeKey, lastModified: o.LastModified?.toISOString(), markdown: redact(await o.Body!.transformToString()) };
});

// ---------------------------------------------------------------- inventory
export const getInventory = cached(60_000, async () => {
  const stacks = await Promise.all(
    config.stacks.map(async (name) => {
      try {
        const st = (await cfn.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
        const types: Record<string, number> = {};
        for await (const page of paginateListStackResources({ client: cfn }, { StackName: name })) {
          for (const r of page.StackResourceSummaries ?? []) types[r.ResourceType!] = (types[r.ResourceType!] ?? 0) + 1;
        }
        return { name, status: st?.StackStatus, lastUpdated: (st?.LastUpdatedTime ?? st?.CreationTime)?.toISOString(), description: st?.Description, resources: Object.values(types).reduce((a, b) => a + b, 0), types };
      } catch (e) {
        return { name, status: 'NOT_FOUND', error: (e as Error).message, resources: 0, types: {} as Record<string, number> };
      }
    }),
  );
  const allTypes: Record<string, number> = {};
  for (const s of stacks) for (const [t, n] of Object.entries(s.types)) allTypes[t] = (allTypes[t] ?? 0) + n;
  // Real AWS services only: skip CDK metadata and Custom:: resources (implemented by CDK helper Lambdas).
  const services = [...new Set(Object.keys(allTypes).filter((t) => t.startsWith('AWS::') && t !== 'AWS::CDK::Metadata').map((t) => t.split('::')[1]))].sort();

  const runtimes = await Promise.all(
    config.runtimeArns.map(async (arn) => {
      const r = await agentcore.send(new GetAgentRuntimeCommand({ agentRuntimeId: arn.split('/').pop()! }));
      return {
        name: r.agentRuntimeName, status: r.status, arn, version: r.agentRuntimeVersion, protocol: r.protocolConfiguration?.serverProtocol,
        network: r.networkConfiguration?.networkMode, inboundAuth: r.authorizerConfiguration ? 'JWT' : 'IAM (SigV4)',
        image: r.agentRuntimeArtifact?.containerConfiguration?.containerUri?.split('/').pop(), lastUpdated: r.lastUpdatedAt?.toISOString(),
      };
    }),
  );
  const functions = await Promise.all(
    config.functions.map(async (name) => {
      const f = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      const env = f.Environment?.Variables ?? {};
      return {
        name, runtime: f.Runtime, architecture: f.Architectures?.[0], memoryMb: f.MemorySize, timeoutSec: f.Timeout, lastModified: f.LastModified,
        // The Workbench API has no MODEL_ID: its model comes from AppConfig at run time (see modelRouting).
        modelId: env.MODEL_ID ?? (env.APPCONFIG_SELECTION_PROFILE_ID ? 'chosen at run time from AWS AppConfig (see modelRouting)' : undefined), reasoning: env.REASONING, description: f.Description,
      };
    }),
  );
  const users: Record<string, number> = {};
  for (const g of config.groups) {
    let n = 0;
    for await (const page of paginateListUsersInGroup({ client: idp }, { UserPoolId: config.userPoolId, GroupName: g })) n += page.Users?.length ?? 0;
    users[g] = n;
  }
  return redact({
    generatedAt: new Date().toISOString(),
    totals: { stacks: stacks.length, resources: Object.values(allTypes).reduce((a, b) => a + b, 0), distinctResourceTypes: Object.keys(allTypes).length, awsServices: services.length },
    awsServices: services,
    resourceTypes: Object.fromEntries(Object.entries(allTypes).sort((a, b) => b[1] - a[1])),
    stacks,
    agentCoreRuntimes: runtimes,
    lambdaFunctions: functions,
    cognitoUsersByGroup: users,
    knowledgeBase: await getKnowledgeBaseInfo().catch((e) => ({ error: (e as Error).message })),
    modelRouting: await getModelRouting().then((r) => ({ activeModel: r.activeModel, weights: r.selection.weights, updatedBy: r.selection.updatedBy, updatedAt: r.selection.updatedAt })).catch((e) => ({ error: (e as Error).message })),
  });
});

// ---------------------------------------------------------------- logs
export const listLogSources = () => config.logSources.map(({ id, label, description, logGroup }) => ({ id, label, description, logGroup }));

function source(id: string): LogSource {
  const s = config.logSources.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown log source "${id}". Known: ${config.logSources.map((x) => x.id).join(', ')}`);
  return s;
}

/** CloudWatch filter syntax is passed through when it looks like a pattern; plain words become a quoted term. */
const toPattern = (f?: string) => (!f ? undefined : /^[{"?\[]/.test(f.trim()) ? f.trim() : `"${f.replace(/"/g, '')}"`);

export async function searchLogs(args: { source: string; filter?: string; minutes?: number; limit?: number }) {
  const s = source(args.source);
  const minutes = Math.min(Math.max(args.minutes ?? 60, 1), 7 * 24 * 60);
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
  const events: { ts: string; message: unknown }[] = [];
  let nextToken: string | undefined;
  do {
    const r = await logs.send(new FilterLogEventsCommand({ logGroupName: s.logGroup, startTime: Date.now() - minutes * 60_000, filterPattern: toPattern(args.filter), nextToken, limit: 500 }));
    for (const e of r.events ?? []) events.push({ ts: new Date(e.timestamp!).toISOString(), message: parse(e.message ?? '') });
    nextToken = r.nextToken;
  } while (nextToken && events.length < 2000);
  return redact({ source: s.id, logGroup: s.logGroup, minutes, filter: args.filter ?? null, matched: events.length, events: events.slice(-limit).reverse() });
}

type Line = Record<string, unknown> & { log_type: string; runId?: string; conversationId?: string; ts?: string };

/** Reasoning log: llm_prompt + llm_call lines from both apps, grouped per run/conversation, newest first. */
export async function getReasoningLogs(args: { app?: 'claims-workbench' | 'class-insights' | 'all'; minutes?: number; limit?: number; runId?: string }) {
  const app = args.app ?? 'all';
  const ids = [...(app !== 'class-insights' ? ['workbench-api'] : []), ...(app !== 'claims-workbench' ? ['insights-chat'] : [])];
  const minutes = Math.min(Math.max(args.minutes ?? 24 * 60, 5), 7 * 24 * 60);
  const pattern = args.runId
    ? `{ ($.runId = "${args.runId.replace(/"/g, '')}" || $.conversationId = "${args.runId.replace(/"/g, '')}") && ($.log_type = "llm_call" || $.log_type = "llm_prompt") }`
    : '{ $.log_type = "llm_call" || $.log_type = "llm_prompt" }';
  const lines: Line[] = [];
  for (const id of ids) {
    const s = config.logSources.find((x) => x.id === id);
    if (!s) continue;
    let nextToken: string | undefined;
    do {
      const r = await logs.send(new FilterLogEventsCommand({ logGroupName: s.logGroup, startTime: Date.now() - minutes * 60_000, filterPattern: pattern, nextToken, limit: 500 }));
      for (const e of r.events ?? []) {
        const p = parse(e.message ?? '');
        if (p && typeof p === 'object') lines.push(p as Line);
      }
      nextToken = r.nextToken;
    } while (nextToken && lines.length < 3000);
  }
  const groups = new Map<string, { id: string; app: unknown; startedAt?: string; prompt?: Line; calls: Line[] }>();
  for (const l of lines) {
    const id = String(l.runId ?? l.conversationId ?? 'unknown');
    const g = groups.get(id) ?? { id, app: l.app, calls: [] };
    if (l.log_type === 'llm_prompt') g.prompt = l;
    else g.calls.push(l);
    g.startedAt = [g.startedAt, l.ts].filter(Boolean).sort()[0];
    groups.set(id, g);
  }
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const runs = [...groups.values()]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit)
    .map((g) => ({ ...g, calls: g.calls.sort((a, b) => Number(a.turn ?? 0) - Number(b.turn ?? 0)) }));
  return redact({ app, minutes, runsFound: groups.size, runs });
}

// ---------------------------------------------------------------- metrics
export async function getMetrics(args: { hours?: number }) {
  const hours = Math.min(Math.max(args.hours ?? 24, 1), 24 * 14);
  const q = (id: string, ns: string, name: string, stat: string): MetricDataQuery => ({
    Id: id, MetricStat: { Metric: { Namespace: ns, MetricName: name, Dimensions: [] }, Period: hours * 3600, Stat: stat },
  });
  const queries = [
    q('analyses_ok', config.metricsNamespace, 'AnalysisSuccess', 'Sum'),
    q('analyses_failed', config.metricsNamespace, 'AnalysisFailure', 'Sum'),
    q('analysis_avg_ms', config.metricsNamespace, 'AnalysisDuration', 'Average'),
    q('workbench_input_tokens', config.metricsNamespace, 'InputTokens', 'Sum'),
    q('workbench_output_tokens', config.metricsNamespace, 'OutputTokens', 'Sum'),
    q('chat_ok', config.insightsNamespace, 'ChatSuccess', 'Sum'),
    q('chat_failed', config.insightsNamespace, 'ChatFailure', 'Sum'),
    q('chat_input_tokens', config.insightsNamespace, 'InputTokens', 'Sum'),
    q('chat_output_tokens', config.insightsNamespace, 'OutputTokens', 'Sum'),
  ];
  const end = new Date();
  const r = await cw.send(new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: new Date(end.getTime() - hours * 3600_000), EndTime: end }));
  return { hours, values: Object.fromEntries((r.MetricDataResults ?? []).map((m) => [m.Id!, Math.round((m.Values ?? []).reduce((a, b) => a + b, 0))])) };
}
