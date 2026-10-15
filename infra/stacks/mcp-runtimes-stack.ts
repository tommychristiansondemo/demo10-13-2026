// The two MCP servers, each deployed as its own Amazon Bedrock AgentCore Runtime (protocol MCP, IAM inbound auth).
// Both runtimes live in one stack: tracingEnabled creates one X-Ray resource policy per stack and the account quota is small.
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

export interface McpRuntimeInfo {
  id: 'claims_policy' | 'damage_repair';
  runtime: agentcore.Runtime;
  appLogGroup: logs.LogGroup;
}

export class McpRuntimesStack extends cdk.Stack {
  readonly runtimes: McpRuntimeInfo[] = [];

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const defs = [
      { id: 'claims_policy', name: 'claims_policy_mcp', dir: 'claims_policy', description: 'Claims & Policy MCP server (synthetic claims, policy coverage, repair estimates, claim status)' },
      { id: 'damage_repair', name: 'damage_repair_mcp', dir: 'damage_repair', description: 'Vehicle Damage & Repair MCP server (simulated damage assessments, repair operations, parts, severity)' },
    ] as const;

    for (const d of defs) {
      // Same-account delivery to /aws/vendedlogs/ needs no extra CloudWatch Logs resource policy.
      const appLogGroup = new logs.LogGroup(this, `${d.name}-AppLogs`, {
        logGroupName: `/aws/vendedlogs/bedrock-agentcore/claims-workbench/${d.name}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const runtime = new agentcore.Runtime(this, d.name, {
        runtimeName: d.name,
        description: d.description,
        agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(path.join(ROOT, 'mcp_servers', d.dir), { platform: Platform.LINUX_ARM64 }),
        protocolConfiguration: agentcore.ProtocolType.MCP,
        authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
        networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
        environmentVariables: { MCP_SERVER_NAME: d.id, OTEL_RESOURCE_ATTRIBUTES: `service.name=${d.name}` },
        lifecycleConfiguration: { idleRuntimeSessionTimeout: cdk.Duration.minutes(10), maxLifetime: cdk.Duration.hours(1) },
        tracingEnabled: true,
        loggingConfigs: [{ logType: agentcore.LogType.APPLICATION_LOGS, destination: agentcore.LoggingDestination.cloudWatchLogs(appLogGroup) }],
        manageDeliveryResourcePolicy: true,
        tags: { project: 'claims-intelligence-workbench' },
      });
      this.runtimes.push({ id: d.id, runtime, appLogGroup });

      new cdk.CfnOutput(this, `${d.name}Arn`, { value: runtime.agentRuntimeArn, exportName: `ClaimsWb-${d.name.replace(/_/g, '-')}-arn` });
    }
  }
}
