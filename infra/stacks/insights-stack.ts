// Class Insights: a separate application that explains everything deployed for the class.
//   insights.<zone> -> CloudFront (own WAF, ACM cert) -> private S3 site
//                                                     -> /api/insights/chat -> chat Lambda (streaming, Bedrock + tools)
//                                                     -> /api/insights/*    -> data Lambda (knowledge, inventory, logs, reasoning)
// projectknowledge.md lives in its own private, versioned S3 bucket (published by scripts/publish_knowledge.py).
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WorkbenchConfig } from '../app.js';
import { METRICS_NAMESPACE, type ApiStack } from './api-stack.js';
import { ANALYST_GROUP, SUPERVISOR_GROUP, type FoundationStack } from './foundation-stack.js';
import type { KnowledgeBaseStack } from './knowledge-base-stack.js';
import type { McpRuntimesStack } from './mcp-runtimes-stack.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SITE_DIST = path.join(ROOT, 'insights-web/dist');
export const INSIGHTS_NAMESPACE = 'ClaimsInsights';
export const INSIGHTS_STACK = 'ClaimsInsights';
/** Every stack of both apps, so the inventory covers the whole class deployment. */
export const CLASS_STACKS = ['ClaimsWb-Foundation', 'ClaimsWb-McpRuntimes', 'ClaimsWb-KnowledgeBase', 'ClaimsWb-Api', 'ClaimsWb-Web', 'ClaimsWb-Observability', INSIGHTS_STACK, 'ClaimsWb-CDKToolkit'];
const CLASS_FUNCTIONS = ['claims-workbench-api', 'claims-workbench-signup', 'claims-insights-api', 'claims-insights-chat'];

export class InsightsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { cfg: WorkbenchConfig; foundation: FoundationStack; mcp: McpRuntimesStack; api: ApiStack; kb: KnowledgeBaseStack }) {
    super(scope, id, props);
    const { cfg, foundation, mcp, api, kb } = props;
    const host = cfg.insightsHostname;
    const siteUrl = `https://${host}`;

    // --- knowledge bucket (private, versioned: every published revision of projectknowledge.md is kept)
    const knowledge = new s3.Bucket(this, 'Knowledge', {
      bucketName: `claims-insights-knowledge-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- sign-in: same user pool as the Workbench (students use the account they already created), own app client
    // Created in THIS stack (userPool.addClient would place it in the Foundation stack).
    const client = new cognito.UserPoolClient(this, 'InsightsWebClient', {
      userPool: foundation.userPool,
      userPoolClientName: 'claims-insights-web',
      generateSecret: false,
      authFlows: { user: true, userSrp: true },
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE], callbackUrls: [`${siteUrl}/`], logoutUrls: [`${siteUrl}/`] },
      accessTokenValidity: cdk.Duration.hours(8),
      idTokenValidity: cdk.Duration.hours(8),
      refreshTokenValidity: cdk.Duration.days(1),
      preventUserExistenceErrors: true,
    });
    new cognito.CfnManagedLoginBranding(this, 'LoginBranding', { userPoolId: foundation.userPool.userPoolId, clientId: client.userPoolClientId, useCognitoProvidedValues: true });

    // --- allow-listed log sources (read-only)
    const runtimeLog = (id: string) => `/aws/bedrock-agentcore/runtimes/${mcp.runtimes.find((r) => r.id === id)!.runtime.agentRuntimeId}-DEFAULT`;
    const logSources = [
      { id: 'workbench-api', label: 'Claims Workbench API + Bedrock agent', logGroup: '/aws/lambda/claims-workbench-api', description: 'api_request, audit_analysis, audit_decision, api_error, mcp_tool_call (client side, with latency), analysis_error, model_selection (a student changed the LLM preferences in AppConfig: weights, ranking, switch decision), and the agent reasoning log: llm_prompt (system prompt, tools, model) and llm_call (model, input, reasoning, output, tool calls, token usage and costUsd per model call).' },
      { id: 'workbench-signup', label: 'Student self-registration trigger', logGroup: '/aws/lambda/claims-workbench-signup', description: 'self_signup events (username, chosen role, group) from the Cognito pre-sign-up / post-confirmation trigger.' },
      { id: 'mcp-claims-policy', label: 'MCP server 1: Claims & Policy (AgentCore Runtime)', logGroup: runtimeLog('claims_policy'), description: 'Container output of the Claims & Policy MCP server: one mcp_tool_call line per tool execution inside the runtime, plus server start-up.' },
      { id: 'mcp-damage-repair', label: 'MCP server 2: Vehicle Damage & Repair (AgentCore Runtime)', logGroup: runtimeLog('damage_repair'), description: 'Container output of the Damage & Repair MCP server: one mcp_tool_call line per tool execution inside the runtime, plus server start-up.' },
      { id: 'insights-chat', label: 'Class Insights chatbot', logGroup: '/aws/lambda/claims-insights-chat', description: 'This chatbot: llm_prompt and llm_call (reasoning log, with token usage and costUsd per call), chat_completed, chat_error.' },
      { id: 'insights-api', label: 'Class Insights data API', logGroup: '/aws/lambda/claims-insights-api', description: 'api_request / api_error lines for the Insights pages.' },
    ];
    const runtimeArns = mcp.runtimes.map((r) => r.runtime.agentRuntimeArn);

    const fnProps = (name: string, entry: string, description: string, timeout: cdk.Duration) => ({
      functionName: name,
      description,
      entry: path.join(ROOT, 'services/insights/src', entry),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: new logs.LogGroup(this, `${entry.replace(/\W/g, '')}Logs`, { logGroupName: `/aws/lambda/${name}`, retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      environment: {
        MODEL_ID: cfg.modelId,
        REASONING: 'adaptive',
        KNOWLEDGE_BUCKET: knowledge.bucketName,
        USER_POOL_ID: foundation.userPool.userPoolId,
        CLIENT_IDS: [client.userPoolClientId, foundation.userPoolClient.userPoolClientId].join(','),
        STACKS: CLASS_STACKS.join(','),
        FUNCTIONS: CLASS_FUNCTIONS.join(','),
        RUNTIME_ARNS: cdk.Fn.join(',', runtimeArns),
        GROUPS: [ANALYST_GROUP, SUPERVISOR_GROUP].join(','),
        LOG_SOURCES: this.toJsonString(logSources),
        METRICS_NAMESPACE,
        INSIGHTS_NAMESPACE,
        KNOWLEDGE_BASE_ID: kb.knowledgeBaseId,
        APPCONFIG_APPLICATION_ID: api.appConfig.applicationId,
        APPCONFIG_ENVIRONMENT_ID: api.appConfig.environmentId,
        APPCONFIG_CATALOG_PROFILE_ID: api.appConfig.catalogProfileId,
        APPCONFIG_SELECTION_PROFILE_ID: api.appConfig.selectionProfileId,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { format: OutputFormat.CJS, target: 'node22', sourceMap: true, minify: false },
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
    });
    const apiFn = new NodejsFunction(this, 'InsightsApi', fnProps('claims-insights-api', 'api-handler.ts', 'Class Insights data API: knowledge, live inventory, logs, reasoning logs, metrics, model routing, LLM costs, Cost Explorer (read-only)', cdk.Duration.seconds(30)));
    const chatFn = new NodejsFunction(this, 'InsightsChat', fnProps('claims-insights-chat', 'chat-handler.ts', 'Class Insights chatbot: Bedrock ConverseStream + adaptive thinking + read-only tools', cdk.Duration.minutes(5)));

    // --- least privilege, read-only
    for (const fn of [apiFn, chatFn]) {
      knowledge.grantRead(fn);
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadClassStacks', actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources'], resources: CLASS_STACKS.map((s) => `arn:aws:cloudformation:${this.region}:${this.account}:stack/${s}/*`) }));
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadAllowListedLogs', actions: ['logs:FilterLogEvents'], resources: logSources.map((s) => `arn:aws:logs:${this.region}:${this.account}:log-group:${s.logGroup}:*`) }));
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadRuntimes', actions: ['bedrock-agentcore:GetAgentRuntime'], resources: runtimeArns }));
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadFunctionConfig', actions: ['lambda:GetFunctionConfiguration'], resources: CLASS_FUNCTIONS.map((f) => `arn:aws:lambda:${this.region}:${this.account}:function:${f}`) }));
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'CountUsersPerGroup', actions: ['cognito-idp:ListUsersInGroup'], resources: [foundation.userPool.userPoolArn] }));
      const appArn = `arn:aws:appconfig:${this.region}:${this.account}:application/${api.appConfig.applicationId}`;
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadModelRouting', actions: ['appconfig:StartConfigurationSession', 'appconfig:GetLatestConfiguration'], resources: [`${appArn}/environment/${api.appConfig.environmentId}/configuration/*`] }));
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadModelRoutingHistory', actions: ['appconfig:ListDeployments', 'appconfig:GetDeployment'], resources: [`${appArn}/environment/${api.appConfig.environmentId}`, `${appArn}/environment/${api.appConfig.environmentId}/deployment/*`] }));
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'DescribeKnowledgeBase', actions: ['bedrock:GetKnowledgeBase', 'bedrock:ListDataSources', 'bedrock:GetDataSource', 'bedrock:ListIngestionJobs', 'bedrock:Retrieve'], resources: [kb.knowledgeBaseArn] }));
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadCostExplorer', actions: ['ce:GetCostAndUsage', 'ce:GetCostForecast'], resources: ['*'] })); // no resource-level permissions
      fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ReadMetrics', actions: ['cloudwatch:GetMetricData'], resources: ['*'] })); // no resource-level permissions
    }
    const modelName = cfg.modelId.replace(/^(us|eu|apac|global)\./, '');
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'InvokeConfiguredModel',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${cfg.modelId}`, `arn:aws:bedrock:*::foundation-model/${modelName}`],
    }));
    const apiUrl = apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const chatUrl = chatFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, invokeMode: lambda.InvokeMode.RESPONSE_STREAM });

    // --- edge
    if (!cfg.hostedZoneId) throw new Error('workbench.hostedZoneId is required');
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: cfg.hostedZoneId, zoneName: cfg.hostedZoneName });
    const certificate = new acm.Certificate(this, 'Cert', { domainName: host, validation: acm.CertificateValidation.fromDns(zone) });
    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: 'claims-insights-web',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'claims-insights-web', sampledRequestsEnabled: true },
      rules: [
        managedRule('AWSManagedRulesAmazonIpReputationList', 0),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 1),
        { name: 'RateLimitPerIp', priority: 10, action: { block: {} }, statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP', evaluationWindowSec: 300 } }, visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'InsightsRateLimitPerIp', sampledRequestsEnabled: true } },
      ],
    });
    const csp = [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
      `connect-src 'self' ${foundation.cognitoDomainUrl}`, "frame-ancestors 'none'", "base-uri 'self'", `form-action 'self' ${foundation.cognitoDomainUrl}`,
    ].join('; ');
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: false, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline("function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }"),
    });
    const apiBehavior = (url: lambda.FunctionUrl, readTimeout: number): cloudfront.BehaviorOptions => ({
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(url, { readTimeout: cdk.Duration.seconds(readTimeout) }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: headers,
    });
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Class Insights',
      domainNames: [host],
      certificate,
      webAclId: webAcl.attrArn,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: spaRewrite }],
      },
      additionalBehaviors: {
        '/api/insights/chat': apiBehavior(chatUrl, 60), // more specific path first
        '/api/insights/*': apiBehavior(apiUrl, 30),
      },
    });
    for (const [i, RecordType] of [route53.ARecord, route53.AaaaRecord].entries()) {
      new RecordType(this, `Alias${i}`, { zone, recordName: host, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });
    }

    if (!existsSync(SITE_DIST)) throw new Error(`Build the insights site first: (cd insights-web && npm ci && npm run build) -> ${SITE_DIST}`);
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: site,
      sources: [
        s3deploy.Source.asset(SITE_DIST, { exclude: ['config.json'] }),
        s3deploy.Source.jsonData('config.json', { region: this.region, siteUrl, workbenchUrl: `https://${cfg.siteHostname}`, cognitoDomain: foundation.cognitoDomainUrl, userPoolClientId: client.userPoolClientId }),
      ],
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });

    new cdk.CfnOutput(this, 'InsightsUrl', { value: siteUrl });
    new cdk.CfnOutput(this, 'KnowledgeBucket', { value: knowledge.bucketName });
    new cdk.CfnOutput(this, 'KnowledgeObject', { value: `s3://${knowledge.bucketName}/projectknowledge.md` });
    new cdk.CfnOutput(this, 'InsightsDistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'InsightsUserPoolClientId', { value: client.userPoolClientId });
  }
}

function managedRule(name: string, priority: number): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
  };
}
