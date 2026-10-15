// Application API + AI orchestrator: one Node.js Lambda behind a streaming Function URL (only CloudFront can call it).
import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkbenchConfig } from '../app.js';
import { ANALYST_GROUP, SUPERVISOR_GROUP, type FoundationStack } from './foundation-stack.js';
import type { KnowledgeBaseStack } from './knowledge-base-stack.js';
import type { McpRuntimesStack } from './mcp-runtimes-stack.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const METRICS_NAMESPACE = 'ClaimsWorkbench';

/** The candidate LLMs (prices + measured benchmark), produced by scripts/model_benchmark.py. */
export const MODEL_CATALOG = JSON.parse(readFileSync(path.join(ROOT, 'config/model-catalog.json'), 'utf8')) as {
  models: { key: string; modelId: string; foundationModel: string }[];
};

/** Initial preferences. Students change them at runtime (new AppConfig versions); CDK only sets the starting point. */
const INITIAL_SELECTION = {
  weights: { quality: 50, cost: 25, latency: 25 },
  activeModel: 'claude-sonnet-4-6',
  qualityFloor: 70,
  switchMargin: 1,
  updatedBy: 'deployment',
  updatedAt: '2026-10-14T00:00:00Z',
  reason: 'Initial configuration: quality 50%, cost 25%, latency 25%.',
};

/** AppConfig validates every new selection version against this schema before it can be deployed. */
const SELECTION_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['weights', 'activeModel', 'qualityFloor', 'switchMargin'],
  properties: {
    weights: {
      type: 'object',
      required: ['quality', 'cost', 'latency'],
      additionalProperties: false,
      properties: Object.fromEntries(['quality', 'cost', 'latency'].map((k) => [k, { type: 'integer', minimum: 0, maximum: 100 }])),
    },
    activeModel: { type: 'string', enum: MODEL_CATALOG.models.map((m) => m.key) },
    qualityFloor: { type: 'number', minimum: 0, maximum: 100 },
    switchMargin: { type: 'number', minimum: 0, maximum: 100 },
  },
};

export class ApiStack extends cdk.Stack {
  readonly fn: NodejsFunction;
  readonly fnUrl: lambda.FunctionUrl;
  readonly logGroup: logs.LogGroup;
  readonly appConfig: { applicationId: string; environmentId: string; catalogProfileId: string; selectionProfileId: string; strategyId: string };

  constructor(scope: Construct, id: string, props: cdk.StackProps & { cfg: WorkbenchConfig; foundation: FoundationStack; mcp: McpRuntimesStack; kb: KnowledgeBaseStack }) {
    super(scope, id, props);
    const { foundation, mcp, kb } = props;
    const arnOf = (id: string) => mcp.runtimes.find((r) => r.id === id)!.runtime.agentRuntimeArn;

    this.logGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: '/aws/lambda/claims-workbench-api',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- AWS AppConfig: which LLM serves live traffic, and the preferences that pick it.
    const app = new appconfig.CfnApplication(this, 'ModelRoutingApp', { name: 'claims-workbench', description: 'Claims Workbench runtime configuration: LLM catalog and model-selection preferences' });
    const env = new appconfig.CfnEnvironment(this, 'ModelRoutingEnv', { applicationId: app.ref, name: 'live', description: 'The deployed application' });
    const strategy = new appconfig.CfnDeploymentStrategy(this, 'InstantStrategy', {
      name: 'claims-wb-instant', description: 'All at once, no bake: a model switch takes effect within seconds (classroom demo)',
      deploymentDurationInMinutes: 0, finalBakeTimeInMinutes: 0, growthFactor: 100, growthType: 'LINEAR', replicateTo: 'NONE',
    });
    const catalogProfile = new appconfig.CfnConfigurationProfile(this, 'CatalogProfile', {
      applicationId: app.ref, name: 'model-catalog', locationUri: 'hosted', type: 'AWS.Freeform',
      description: 'Candidate LLMs: Bedrock ids, invocation settings, AWS list prices and measured benchmark results',
    });
    const selectionProfile = new appconfig.CfnConfigurationProfile(this, 'SelectionProfile', {
      applicationId: app.ref, name: 'model-selection', locationUri: 'hosted', type: 'AWS.Freeform',
      description: 'Preference weights (quality/cost/latency, sum 100) and the active model; changed by students from the UI',
      validators: [{ type: 'JSON_SCHEMA', content: JSON.stringify(SELECTION_SCHEMA) }],
    });
    const catalogVersion = new appconfig.CfnHostedConfigurationVersion(this, 'CatalogVersion', {
      applicationId: app.ref, configurationProfileId: catalogProfile.ref, contentType: 'application/json',
      content: readFileSync(path.join(ROOT, 'config/model-catalog.json'), 'utf8'), description: 'Published by CDK from config/model-catalog.json',
    });
    const selectionVersion = new appconfig.CfnHostedConfigurationVersion(this, 'SelectionVersion', {
      applicationId: app.ref, configurationProfileId: selectionProfile.ref, contentType: 'application/json',
      content: JSON.stringify(INITIAL_SELECTION, null, 2), description: 'Initial preferences: quality 50%, cost 25%, latency 25%',
    });
    const catalogDeploy = new appconfig.CfnDeployment(this, 'CatalogDeployment', {
      applicationId: app.ref, environmentId: env.ref, deploymentStrategyId: strategy.ref, configurationProfileId: catalogProfile.ref,
      configurationVersion: catalogVersion.ref, description: 'CDK: model catalog',
    });
    const selectionDeploy = new appconfig.CfnDeployment(this, 'SelectionDeployment', {
      applicationId: app.ref, environmentId: env.ref, deploymentStrategyId: strategy.ref, configurationProfileId: selectionProfile.ref,
      configurationVersion: selectionVersion.ref, description: 'CDK: initial preferences (quality 50 / cost 25 / latency 25)',
    });
    selectionDeploy.addDependency(catalogDeploy); // one deployment at a time per environment
    this.appConfig = {
      applicationId: app.ref, environmentId: env.ref, catalogProfileId: catalogProfile.ref, selectionProfileId: selectionProfile.ref, strategyId: strategy.ref,
    };

    this.fn = new NodejsFunction(this, 'Api', {
      functionName: 'claims-workbench-api',
      description: 'Claims Workbench API + Bedrock orchestrator (MCP client to two AgentCore runtimes)',
      entry: path.join(ROOT, 'services/api/src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(5),
      logGroup: this.logGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        APPCONFIG_APPLICATION_ID: app.ref,
        APPCONFIG_ENVIRONMENT_ID: env.ref,
        APPCONFIG_CATALOG_PROFILE_ID: catalogProfile.ref,
        APPCONFIG_SELECTION_PROFILE_ID: selectionProfile.ref,
        APPCONFIG_STRATEGY_ID: strategy.ref,
        TABLE_NAME: foundation.table.tableName,
        USER_POOL_ID: foundation.userPool.userPoolId,
        USER_POOL_CLIENT_ID: foundation.userPoolClient.userPoolClientId,
        ANALYST_GROUP,
        SUPERVISOR_GROUP,
        CLAIMS_MCP_RUNTIME_ARN: arnOf('claims_policy'),
        DAMAGE_MCP_RUNTIME_ARN: arnOf('damage_repair'),
        METRICS_NAMESPACE,
        KNOWLEDGE_BASE_ID: kb.knowledgeBaseId,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { format: OutputFormat.CJS, target: 'node22', sourceMap: true, minify: false },
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
    });

    // Least privilege: read/write the runs table, invoke exactly the two MCP runtimes, invoke exactly the catalog models.
    foundation.table.grantReadWriteData(this.fn);
    for (const r of mcp.runtimes) r.runtime.grantInvokeRuntime(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeCatalogModels',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: MODEL_CATALOG.models.flatMap((m) => [
          ...(m.modelId !== m.foundationModel ? [`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${m.modelId}`] : []),
          `arn:aws:bedrock:*::foundation-model/${m.foundationModel}`,
        ]),
      }),
    );
    this.fn.addToRolePolicy(new iam.PolicyStatement({ sid: 'SearchClaimsManual', actions: ['bedrock:Retrieve'], resources: [kb.knowledgeBaseArn] }));
    const appArn = `arn:aws:appconfig:${this.region}:${this.account}:application/${app.ref}`;
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadRuntimeConfig',
      actions: ['appconfig:StartConfigurationSession', 'appconfig:GetLatestConfiguration'],
      resources: [`${appArn}/environment/${env.ref}/configuration/*`],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ChangeModelSelection',
      actions: ['appconfig:CreateHostedConfigurationVersion', 'appconfig:StartDeployment', 'appconfig:GetDeployment', 'appconfig:ListDeployments'],
      // AppConfig authorizes some of these against the application ARN itself, not only the sub-resource.
      resources: [
        appArn,
        `${appArn}/configurationprofile/${selectionProfile.ref}`,
        `${appArn}/environment/${env.ref}`,
        `${appArn}/environment/${env.ref}/deployment/*`,
        `arn:aws:appconfig:${this.region}:${this.account}:deploymentstrategy/${strategy.ref}`,
      ],
    }));

    this.fnUrl = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, invokeMode: lambda.InvokeMode.RESPONSE_STREAM });

    new cdk.CfnOutput(this, 'ApiFunctionName', { value: this.fn.functionName });
    new cdk.CfnOutput(this, 'AppConfigApplicationId', { value: app.ref });
    new cdk.CfnOutput(this, 'AppConfigEnvironmentId', { value: env.ref });
    new cdk.CfnOutput(this, 'AppConfigSelectionProfileId', { value: selectionProfile.ref });
    new cdk.CfnOutput(this, 'AppConfigCatalogProfileId', { value: catalogProfile.ref });
  }
}
