// One CloudWatch dashboard for the whole workflow + alarms (SNS topic; email subscription only if configured).
import * as cdk from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { WorkbenchConfig } from '../app.js';
import { METRICS_NAMESPACE, type ApiStack } from './api-stack.js';
import type { McpRuntimesStack } from './mcp-runtimes-stack.js';
import type { WebStack } from './web-stack.js';

export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { cfg: WorkbenchConfig; mcp: McpRuntimesStack; api: ApiStack; web: WebStack }) {
    super(scope, id, props);
    const { cfg, mcp, api, web } = props;

    const topic = new sns.Topic(this, 'Alarms', { topicName: 'claims-workbench-alarms' });
    if (cfg.alarmEmail) topic.addSubscription(new subs.EmailSubscription(cfg.alarmEmail));
    const notify = new cwActions.SnsAction(topic);

    const m = (metricName: string, statistic = 'Sum', dimensionsMap?: Record<string, string>) =>
      new cw.Metric({ namespace: METRICS_NAMESPACE, metricName, statistic, dimensionsMap, period: cdk.Duration.minutes(5) });
    const servers = ['claims_policy', 'damage_repair'];
    const runtimeLogGroups = mcp.runtimes.map((r) => `/aws/bedrock-agentcore/runtimes/${r.runtime.agentRuntimeId}-DEFAULT`);

    const dashboard = new cw.Dashboard(this, 'Dashboard', { dashboardName: 'claims-workbench' });
    dashboard.addWidgets(
      new cw.TextWidget({
        width: 24,
        height: 2,
        markdown: `# Claims Intelligence Workbench\nBrowser -> CloudFront/WAF -> API Lambda (Bedrock model chosen at runtime from AWS AppConfig) -> **2 MCP servers on AgentCore Runtime**: ${mcp.runtimes.map((r) => `\`${r.runtime.agentRuntimeId}\``).join(', ')}`,
      }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({ title: 'AI analyses', width: 8, left: [m('AnalysisSuccess'), m('AnalysisFailure')] }),
      new cw.GraphWidget({ title: 'Analysis duration (ms)', width: 8, left: [m('AnalysisDuration', 'p50'), m('AnalysisDuration', 'p90')] }),
      new cw.GraphWidget({ title: 'Model tokens', width: 8, left: [m('InputTokens'), m('OutputTokens')] }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({ title: 'MCP tool calls by server (agent)', width: 8, left: servers.map((s) => m('ToolCallSuccess', 'Sum', { Server: s })), right: servers.map((s) => m('ToolCallError', 'Sum', { Server: s })) }),
      new cw.LogQueryWidget({
        title: 'MCP tool latency by server/tool (ms, from API logs)',
        width: 16,
        logGroupNames: [api.logGroup.logGroupName],
        view: cw.LogQueryVisualizationType.TABLE,
        queryLines: ['filter log_type = "mcp_tool_call"', 'stats count() as calls, avg(latencyMs) as avg_ms, pct(latencyMs, 90) as p90_ms, sum(ok = 0) as errors by server, tool', 'sort server, tool'],
      }),
    );
    dashboard.addWidgets(
      new cw.LogQueryWidget({
        title: 'Tool calls as seen inside the MCP runtimes',
        width: 12,
        logGroupNames: runtimeLogGroups,
        view: cw.LogQueryVisualizationType.TABLE,
        queryLines: ['filter log_type = "mcp_tool_call"', 'stats count() as calls, avg(latency_ms) as avg_ms by server, tool, outcome'],
      }),
      new cw.LogQueryWidget({
        title: 'Audit: analyses and supervisor decisions',
        width: 12,
        logGroupNames: [api.logGroup.logGroupName],
        view: cw.LogQueryVisualizationType.TABLE,
        queryLines: ['filter log_type in ["audit_analysis", "audit_decision"]', 'fields @timestamp, log_type, claimId, runId, by, coalesce(disposition, decision) as outcome', 'sort @timestamp desc', 'limit 50'],
      }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({ title: 'API Lambda', width: 12, left: [api.fn.metricInvocations(), api.fn.metricErrors(), api.fn.metricThrottles()], right: [api.fn.metricDuration({ statistic: 'p90' })] }),
      new cw.GraphWidget({
        title: 'WAF (blocked vs allowed)',
        width: 12,
        left: ['BlockedRequests', 'AllowedRequests'].map(
          (metricName) => new cw.Metric({ namespace: 'AWS/WAFV2', metricName, region: 'us-east-1', dimensionsMap: { WebACL: web.webAclName, Rule: 'ALL' }, statistic: 'Sum' }),
        ),
      }),
    );

    const alarms = [
      new cw.Alarm(this, 'ApiErrors', { alarmName: 'claims-workbench-api-errors', metric: api.fn.metricErrors({ period: cdk.Duration.minutes(5) }), threshold: 3, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING }),
      new cw.Alarm(this, 'AnalysisFailures', { alarmName: 'claims-workbench-analysis-failures', metric: m('AnalysisFailure'), threshold: 2, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING }),
      new cw.Alarm(this, 'McpToolErrors', {
        alarmName: 'claims-workbench-mcp-tool-errors',
        metric: new cw.MathExpression({ expression: 'SUM([a,b])', usingMetrics: { a: m('ToolCallError', 'Sum', { Server: servers[0] }), b: m('ToolCallError', 'Sum', { Server: servers[1] }) }, period: cdk.Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, 'SlowAnalyses', { alarmName: 'claims-workbench-slow-analyses', metric: m('AnalysisDuration', 'p90'), threshold: 180_000, evaluationPeriods: 2, treatMissingData: cw.TreatMissingData.NOT_BREACHING }),
    ];
    for (const a of alarms) a.addAlarmAction(notify);

    new cdk.CfnOutput(this, 'DashboardUrl', { value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/claims-workbench` });
  }
}
