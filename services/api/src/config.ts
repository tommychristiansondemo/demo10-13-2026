// Runtime configuration, injected by CDK as Lambda environment variables (or by local-server.ts for local dev).

export interface McpServerConfig {
  id: 'claims_policy' | 'damage_repair';
  label: string;
  /** AgentCore Runtime ARN (deployed) ... */
  runtimeArn?: string;
  /** ... or a plain URL for local development (no SigV4). */
  localUrl?: string;
}

const env = process.env;

export const config = {
  region: env.AWS_REGION ?? 'us-east-1',
  maxAgentTurns: Number(env.MAX_AGENT_TURNS ?? 14),
  /** Which LLM serves traffic is not configured here: it is read from AWS AppConfig at run time (see appconfig.ts). */
  appConfig: {
    applicationId: env.APPCONFIG_APPLICATION_ID ?? '',
    environmentId: env.APPCONFIG_ENVIRONMENT_ID ?? '',
    catalogProfileId: env.APPCONFIG_CATALOG_PROFILE_ID ?? '',
    selectionProfileId: env.APPCONFIG_SELECTION_PROFILE_ID ?? '',
    strategyId: env.APPCONFIG_STRATEGY_ID ?? '',
  },
  /** Bedrock Knowledge Base with the claims-handling manual; empty disables the agent's search_guidelines tool. */
  knowledgeBaseId: env.KNOWLEDGE_BASE_ID ?? '',
  tableName: env.TABLE_NAME ?? '',
  userPoolId: env.USER_POOL_ID ?? '',
  userPoolClientId: env.USER_POOL_CLIENT_ID ?? '',
  analystGroup: env.ANALYST_GROUP ?? 'claims-analysts',
  supervisorGroup: env.SUPERVISOR_GROUP ?? 'claims-supervisors',
  localDev: env.LOCAL_DEV === '1',
  metricsNamespace: env.METRICS_NAMESPACE ?? 'ClaimsWorkbench',
  mcpServers: [
    {
      id: 'claims_policy',
      label: 'Claims & Policy',
      runtimeArn: env.CLAIMS_MCP_RUNTIME_ARN || undefined,
      localUrl: env.CLAIMS_MCP_URL || undefined,
    },
    {
      id: 'damage_repair',
      label: 'Vehicle Damage & Repair',
      runtimeArn: env.DAMAGE_MCP_RUNTIME_ARN || undefined,
      localUrl: env.DAMAGE_MCP_URL || undefined,
    },
  ] satisfies McpServerConfig[],
};
