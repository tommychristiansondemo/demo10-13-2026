// Class Insights runtime configuration (injected by CDK as Lambda environment variables).
export interface LogSource {
  id: string;
  label: string;
  logGroup: string;
  description: string;
}

const env = process.env;
const json = <T>(v: string | undefined, fallback: T): T => (v ? (JSON.parse(v) as T) : fallback);

export const config = {
  region: env.AWS_REGION ?? 'us-east-1',
  modelId: env.MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6',
  knowledgeBucket: env.KNOWLEDGE_BUCKET ?? '',
  knowledgeKey: 'projectknowledge.md',
  userPoolId: env.USER_POOL_ID ?? '',
  /** Access tokens from either app client are accepted (same Cognito user pool as the Claims Workbench). */
  clientIds: (env.CLIENT_IDS ?? '').split(',').filter(Boolean),
  stacks: (env.STACKS ?? '').split(',').filter(Boolean),
  functions: (env.FUNCTIONS ?? '').split(',').filter(Boolean),
  runtimeArns: (env.RUNTIME_ARNS ?? '').split(',').filter(Boolean),
  groups: (env.GROUPS ?? '').split(',').filter(Boolean),
  logSources: json<LogSource[]>(env.LOG_SOURCES, []),
  metricsNamespace: env.METRICS_NAMESPACE ?? 'ClaimsWorkbench',
  insightsNamespace: env.INSIGHTS_NAMESPACE ?? 'ClaimsInsights',
  maxTurns: 8,
  localDev: env.LOCAL_DEV === '1',
};
