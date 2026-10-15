#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from './stacks/api-stack.js';
import { FoundationStack } from './stacks/foundation-stack.js';
import { INSIGHTS_STACK, InsightsStack } from './stacks/insights-stack.js';
import { KnowledgeBaseStack } from './stacks/knowledge-base-stack.js';
import { McpRuntimesStack } from './stacks/mcp-runtimes-stack.js';
import { ObservabilityStack } from './stacks/observability-stack.js';
import { WebStack } from './stacks/web-stack.js';

export interface WorkbenchConfig {
  account: string;
  region: string;
  hostedZoneName: string;
  hostedZoneId: string;
  siteHostname: string;
  modelId: string;
  alarmEmail: string;
  selfSignUp: boolean;
  localDevCallbackUrl: string;
  insightsHostname: string;
}

const app = new cdk.App();
const cfg = { ...(app.node.tryGetContext('workbench') as WorkbenchConfig) };
// Deploy scripts pass resolved values as flat context (-c hostedZoneId=Z123 -c account=1234 -c modelId=...).
for (const key of ['account', 'hostedZoneId', 'modelId'] as const) cfg[key] = app.node.tryGetContext(key) ?? cfg[key] ?? '';
const env = { account: cfg.account || process.env.CDK_DEFAULT_ACCOUNT, region: cfg.region };
// Own bootstrap stack (qualifier in cdk.json) so this demo never depends on, or damages, the shared CDKToolkit.
const synthesizer = new cdk.DefaultStackSynthesizer({ qualifier: app.node.tryGetContext('@aws-cdk/core:bootstrapQualifier') });
const common = { env, synthesizer };

const foundation = new FoundationStack(app, 'ClaimsWb-Foundation', { ...common, cfg });
const mcp = new McpRuntimesStack(app, 'ClaimsWb-McpRuntimes', { ...common });
// Bedrock Knowledge Base (claims-handling manual on S3 Vectors) that the agent searches for procedures.
const kb = new KnowledgeBaseStack(app, 'ClaimsWb-KnowledgeBase', { ...common });
const api = new ApiStack(app, 'ClaimsWb-Api', { ...common, cfg, foundation, mcp, kb });
const web = new WebStack(app, 'ClaimsWb-Web', { ...common, cfg, foundation, api });
new ObservabilityStack(app, 'ClaimsWb-Observability', { ...common, cfg, mcp, api, web });
// A separate application (own site, buckets, Lambdas, CloudFront, WAF, cert) that explains the deployment to students.
new InsightsStack(app, INSIGHTS_STACK, { ...common, cfg, foundation, mcp, api, kb });

cdk.Tags.of(app).add('project', 'claims-intelligence-workbench');
cdk.Tags.of(app).add('purpose', 'training-demo');
