// Identity (Cognito) and application data (DynamoDB + KMS).
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import path from 'node:path';
import type { WorkbenchConfig } from '../app.js';

export const ANALYST_GROUP = 'claims-analysts';
export const SUPERVISOR_GROUP = 'claims-supervisors';
const ROOT = path.resolve(import.meta.dirname, '../..');

export class FoundationStack extends cdk.Stack {
  readonly key: kms.Key;
  readonly table: dynamodb.Table;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly cognitoDomainUrl: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps & { cfg: WorkbenchConfig }) {
    super(scope, id, props);
    const { cfg } = props;

    this.key = new kms.Key(this, 'DataKey', {
      alias: 'alias/claims-workbench-data',
      description: 'Claims Intelligence Workbench application data',
      enableKeyRotation: true,
      pendingWindow: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Recommendation runs and supervisor decisions: pk = claimId, sk = runId (time sortable).
    this.table = new dynamodb.Table(this, 'Runs', {
      tableName: 'claims-workbench-runs',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: 'claims-workbench-users',
      signInAliases: { username: true },
      signInCaseSensitive: false,
      selfSignUpEnabled: cfg.selfSignUp,
      // Training demo: lightest restrictions Cognito allows. 6 characters is Cognito's floor; no character classes.
      passwordPolicy: { minLength: 6, requireDigits: false, requireLowercase: false, requireUppercase: false, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.NONE,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    for (const [groupName, description, precedence] of [
      [ANALYST_GROUP, 'Can view claims and request AI analyses', 20],
      [SUPERVISOR_GROUP, 'Can also approve, reject or return AI recommendations', 10],
    ] as const) {
      new cognito.CfnUserPoolGroup(this, `Group-${groupName}`, { userPoolId: this.userPool.userPoolId, groupName, description, precedence });
    }

    // Student self-registration: auto-confirm (no email/code) and put the user in the group for the chosen role.
    const signupLogs = new logs.LogGroup(this, 'SignupTriggerLogs', {
      logGroupName: '/aws/lambda/claims-workbench-signup',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const signupTrigger = new NodejsFunction(this, 'SignupTrigger', {
      functionName: 'claims-workbench-signup',
      description: 'Cognito pre-sign-up (auto-confirm) + post-confirmation (role -> group) for student self-registration',
      entry: path.join(ROOT, 'services/signup/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      logGroup: signupLogs,
      environment: { ANALYST_GROUP, SUPERVISOR_GROUP },
      bundling: { format: OutputFormat.CJS, target: 'node22', minify: false },
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
    });
    // Pool ARN pattern (not the pool's own ARN) avoids a pool <-> trigger dependency cycle.
    signupTrigger.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminAddUserToGroup'],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`],
    }));
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, signupTrigger);
    this.userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, signupTrigger);

    const siteUrl = `https://${cfg.siteHostname}/`;
    // Deployed app only trusts its own HTTPS origin; a localhost callback is added only if explicitly configured.
    const appUrls = [siteUrl, ...(cfg.localDevCallbackUrl ? [cfg.localDevCallbackUrl] : [])];
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'claims-workbench-web',
      generateSecret: false, // public SPA client: authorization code + PKCE
      authFlows: { user: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: appUrls,
        logoutUrls: appUrls,
      },
      accessTokenValidity: cdk.Duration.hours(8),
      idTokenValidity: cdk.Duration.hours(8),
      refreshTokenValidity: cdk.Duration.days(1),
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });

    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `claims-workbench-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const branding = new cognito.CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);
    this.cognitoDomainUrl = domain.baseUrl();

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomainUrl', { value: this.cognitoDomainUrl });
    new cdk.CfnOutput(this, 'RunsTableName', { value: this.table.tableName });
  }
}
