// Public edge: www.<zone> -> CloudFront (WAF, ACM, security headers) -> private S3 SPA + /api/* -> Lambda Function URL (OAC).
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WorkbenchConfig } from '../app.js';
import type { ApiStack } from './api-stack.js';
import type { FoundationStack } from './foundation-stack.js';

const WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist');

export class WebStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;
  readonly webAclName = 'claims-workbench-web';

  constructor(scope: Construct, id: string, props: cdk.StackProps & { cfg: WorkbenchConfig; foundation: FoundationStack; api: ApiStack }) {
    super(scope, id, props);
    const { cfg, foundation, api } = props;
    if (this.region !== 'us-east-1') throw new Error('WebStack must be in us-east-1 (CloudFront certificate + WAF scope)');

    if (!cfg.hostedZoneId) throw new Error('workbench.hostedZoneId is required (scripts/deploy.sh resolves it from hostedZoneName)');
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: cfg.hostedZoneId, zoneName: cfg.hostedZoneName });
    const certificate = new acm.Certificate(this, 'Cert', {
      domainName: cfg.siteHostname,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const bucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: this.webAclName,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: this.webAclName, sampledRequestsEnabled: true },
      rules: [
        managedRule('AWSManagedRulesAmazonIpReputationList', 0),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 1),
        managedRule('AWSManagedRulesCommonRuleSet', 2),
        {
          // Generous: a whole classroom may share one NAT address.
          name: 'RateLimitPerIp',
          priority: 10,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 3000, aggregateKeyType: 'IP', evaluationWindowSec: 300 } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp', sampledRequestsEnabled: true },
        },
      ],
    });

    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      `connect-src 'self' ${foundation.cognitoDomainUrl} https://cognito-idp.${this.region}.amazonaws.com`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      `form-action 'self' ${foundation.cognitoDomainUrl}`,
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
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
      ),
    });

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Claims Intelligence Workbench',
      domainNames: [cfg.siteHostname],
      certificate,
      webAclId: webAcl.attrArn,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // SPA deep links are rewritten at the edge. (Distribution-level errorResponses would also rewrite API 403/404s.)
        functionAssociations: [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: spaRewrite }],
      },
      additionalBehaviors: {
        '/api/*': {
          // OAC signs the origin request with SigV4; the Function URL rejects anything that does not come through CloudFront.
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(api.fnUrl, { readTimeout: cdk.Duration.seconds(60) }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    });

    for (const [i, RecordType] of [route53.ARecord, route53.AaaaRecord].entries()) {
      new RecordType(this, `Alias${i}`, {
        zone,
        recordName: cfg.siteHostname,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      });
    }

    const siteUrl = `https://${cfg.siteHostname}`;
    const runtimeConfig = {
      region: this.region,
      siteUrl,
      cognitoDomain: foundation.cognitoDomainUrl,
      userPoolClientId: foundation.userPoolClient.userPoolClientId,
      selfSignUp: cfg.selfSignUp,
      insightsUrl: `https://${cfg.insightsHostname}`,
    };
    if (!existsSync(WEB_DIST)) throw new Error(`Build the web app first: (cd web && npm ci && npm run build) -> ${WEB_DIST}`);
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(WEB_DIST, { exclude: ['config.json'] }), s3deploy.Source.jsonData('config.json', runtimeConfig)],
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: this.distribution.distributionDomainName });
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
