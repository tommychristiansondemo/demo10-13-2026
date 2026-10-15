"""Tear down everything this demo created, then verify nothing is left.

    .venv/bin/python scripts/teardown.py                    # app stacks + leftovers (keeps CDK bootstrap)
    .venv/bin/python scripts/teardown.py --with-bootstrap   # also ClaimsWb-CDKToolkit, its retained bucket, ECR repo
    .venv/bin/python scripts/teardown.py --dry-run          # show what would be deleted

Things CloudFormation leaves behind that this script handles explicitly:
  * AgentCore runtime log groups (/aws/bedrock-agentcore/runtimes/<id>-DEFAULT) created by the service
  * CDK helper Lambda log groups (/aws/lambda/ClaimsWb-*)
  * ACM DNS-validation CNAMEs in Route 53 (www + insights)
  * demo-user secrets (force-deleted, no 30-day window)
  * CDK bootstrap asset bucket (DeletionPolicy Retain, versioned) and ECR repository
  * AppConfig hosted configuration versions created at runtime by students (model switches), which CloudFormation
    does not own; and the `project` cost allocation tag activated for the Class Insights Costs page
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
CDK = json.loads((ROOT / "cdk.json").read_text())["context"]
CFG = CDK["workbench"]
QUALIFIER = CDK["@aws-cdk/core:bootstrapQualifier"]
REGION = CFG["region"]
STACKS = ["ClaimsInsights", "ClaimsWb-Observability", "ClaimsWb-Web", "ClaimsWb-Api", "ClaimsWb-KnowledgeBase", "ClaimsWb-McpRuntimes", "ClaimsWb-Foundation"]
TOOLKIT = "ClaimsWb-CDKToolkit"

ap = argparse.ArgumentParser()
ap.add_argument("--with-bootstrap", action="store_true")
ap.add_argument("--dry-run", action="store_true")
a = ap.parse_args()

s = boto3.Session(region_name=REGION)
acct = s.client("sts").get_caller_identity()["Account"]
cf, logs, r53, acm, sm = (s.client(x) for x in ("cloudformation", "logs", "route53", "acm", "secretsmanager"))
print(f"Account {acct} region {REGION}{' (dry run)' if a.dry_run else ''}")


def do(label: str, fn):
    print(f"  - {label}")
    if a.dry_run:
        return
    try:
        fn()
    except ClientError as e:
        print(f"    ! {e.response['Error']['Code']}: {e.response['Error']['Message'][:160]}")


def stack_exists(name: str) -> bool:
    try:
        return cf.describe_stacks(StackName=name)["Stacks"][0]["StackStatus"] != "DELETE_COMPLETE"
    except ClientError:
        return False


def zone_id() -> str:
    zones = r53.list_hosted_zones_by_name(DNSName=CFG["hostedZoneName"])["HostedZones"]
    return next(z["Id"].split("/")[-1] for z in zones if z["Name"] == CFG["hostedZoneName"] + ".")


# 1. Capture what the stacks won't clean up, before they disappear.
runtime_ids, validation_records = [], []
if stack_exists("ClaimsWb-McpRuntimes"):
    for res in cf.describe_stack_resources(StackName="ClaimsWb-McpRuntimes")["StackResources"]:
        if res["ResourceType"] == "AWS::BedrockAgentCore::Runtime":
            runtime_ids.append(res["PhysicalResourceId"].split("/")[-1])
for c in acm.list_certificates()["CertificateSummaryList"]:
    if c["DomainName"] in (CFG["siteHostname"], CFG["insightsHostname"]):
        for o in acm.describe_certificate(CertificateArn=c["CertificateArn"])["Certificate"].get("DomainValidationOptions", []):
            if o.get("ResourceRecord"):
                validation_records.append(o["ResourceRecord"])

ac = s.client("appconfig")


def appconfig_apps() -> list[str]:
    return [x["Id"] for x in ac.list_applications()["Items"] if x["Name"] == "claims-workbench"]


def delete_runtime_versions(app_id: str, everything: bool) -> None:
    """Hosted versions written by the API Lambda (students' model selections) are not CloudFormation's to delete."""
    for prof in ac.list_configuration_profiles(ApplicationId=app_id)["Items"]:
        for v in ac.list_hosted_configuration_versions(ApplicationId=app_id, ConfigurationProfileId=prof["Id"], MaxResults=50)["Items"]:
            cdk_owned = (v.get("Description") or "").startswith(("Published by CDK", "Initial preferences"))
            if everything or not cdk_owned:
                do(f"delete AppConfig {prof['Name']} v{v['VersionNumber']}",
                   lambda p=prof["Id"], n=v["VersionNumber"]: ac.delete_hosted_configuration_version(ApplicationId=app_id, ConfigurationProfileId=p, VersionNumber=n))


def delete_appconfig_app(app_id: str) -> None:
    delete_runtime_versions(app_id, everything=True)
    for prof in ac.list_configuration_profiles(ApplicationId=app_id)["Items"]:
        do(f"delete AppConfig profile {prof['Name']}", lambda p=prof["Id"]: ac.delete_configuration_profile(ApplicationId=app_id, ConfigurationProfileId=p, DeletionProtectionCheck="BYPASS"))
    for env in ac.list_environments(ApplicationId=app_id)["Items"]:
        do(f"delete AppConfig environment {env['Name']}", lambda e=env["Id"]: ac.delete_environment(ApplicationId=app_id, EnvironmentId=e, DeletionProtectionCheck="BYPASS"))
    do(f"delete AppConfig application {app_id}", lambda: ac.delete_application(ApplicationId=app_id))


print("\nAppConfig (runtime-created versions)")
for app_id in appconfig_apps():
    delete_runtime_versions(app_id, everything=False)

# 2. Delete app stacks (reverse dependency order).
print("\nStacks")
zid = zone_id()
for dist in (ROOT / "web/dist", ROOT / "insights-web/dist"):
    dist.mkdir(parents=True, exist_ok=True)  # cdk destroy synthesizes the app, which needs the site folders to exist
if any(stack_exists(x) for x in STACKS):
    cmd = ["npx", "cdk", "destroy", "--all", "--force", "--toolkit-stack-name", TOOLKIT, "-c", f"account={acct}", "-c", f"hostedZoneId={zid}"]
    do(" ".join(cmd), lambda: subprocess.run(cmd, cwd=ROOT, check=True))
else:
    print("  - no app stacks found")

# 3. Leftovers.
print("\nLeftovers")
groups = []
for prefix in ["/aws/bedrock-agentcore/runtimes/", "/aws/lambda/ClaimsWb-", "/aws/lambda/ClaimsInsights-", "/aws/lambda/claims-workbench", "/aws/lambda/claims-insights", "/aws/vendedlogs/bedrock-agentcore/claims-workbench"]:
    for page in logs.get_paginator("describe_log_groups").paginate(logGroupNamePrefix=prefix):
        groups += [g["logGroupName"] for g in page["logGroups"]]
for g in groups:
    if g.startswith("/aws/bedrock-agentcore/runtimes/") and not any(g.split("/")[-1].startswith(rid) for rid in runtime_ids) \
            and not ("claims_policy_mcp" in g or "damage_repair_mcp" in g):
        continue  # someone else's runtime
    do(f"delete log group {g}", lambda g=g: logs.delete_log_group(logGroupName=g))

for app_id in appconfig_apps():  # only if CloudFormation could not delete it
    delete_appconfig_app(app_id)
for st in ac.list_deployment_strategies()["Items"]:
    if st["Name"] == "claims-wb-instant":
        do("delete AppConfig deployment strategy claims-wb-instant", lambda i=st["Id"]: ac.delete_deployment_strategy(DeploymentStrategyId=i))
do("deactivate the 'project' cost allocation tag (activated for the Costs page)",
   lambda: s.client("ce", region_name="us-east-1").update_cost_allocation_tags_status(CostAllocationTagsStatus=[{"TagKey": "project", "Status": "Inactive"}]))

for rec in validation_records:
    def delete_cname(rec=rec):
        rrs = r53.list_resource_record_sets(HostedZoneId=zid, StartRecordName=rec["Name"], StartRecordType="CNAME", MaxItems="1")["ResourceRecordSets"]
        if rrs and rrs[0]["Name"] == rec["Name"] and rrs[0]["Type"] == "CNAME":
            r53.change_resource_record_sets(HostedZoneId=zid, ChangeBatch={"Changes": [{"Action": "DELETE", "ResourceRecordSet": rrs[0]}]})
    do(f"delete ACM validation CNAME {rec['Name']}", delete_cname)

for page in sm.get_paginator("list_secrets").paginate(Filters=[{"Key": "name", "Values": ["claims-workbench/"]}], IncludePlannedDeletion=True):
    for sec in page["SecretList"]:
        do(f"force-delete secret {sec['Name']}", lambda n=sec["ARN"]: sm.delete_secret(SecretId=n, ForceDeleteWithoutRecovery=True))

# 4. Optional: our own CDK bootstrap.
if a.with_bootstrap:
    print("\nBootstrap")
    bucket = f"cdk-{QUALIFIER}-assets-{acct}-{REGION}"
    repo = f"cdk-{QUALIFIER}-container-assets-{acct}-{REGION}"
    ecr, s3 = s.client("ecr"), s.resource("s3")

    def empty_repo():
        try:
            ecr.delete_repository(repositoryName=repo, force=True)
        except ecr.exceptions.RepositoryNotFoundException:
            pass

    def delete_toolkit():
        cf.delete_stack(StackName=TOOLKIT)
        cf.get_waiter("stack_delete_complete").wait(StackName=TOOLKIT)

    def delete_bucket():
        b = s3.Bucket(bucket)
        try:
            b.object_versions.delete()
            b.delete()
        except ClientError as e:
            if e.response["Error"]["Code"] != "NoSuchBucket":
                raise

    do(f"force-delete ECR repository {repo}", empty_repo)
    if stack_exists(TOOLKIT):
        do(f"delete stack {TOOLKIT}", delete_toolkit)
    do(f"empty (all versions) and delete retained bucket {bucket}", delete_bucket)
    do(f"delete SSM /cdk-bootstrap/{QUALIFIER}/version", lambda: s.client("ssm").delete_parameter(Name=f"/cdk-bootstrap/{QUALIFIER}/version"))

# 5. Verify.
if a.dry_run:
    sys.exit(0)
print("\nVerification sweep")
time.sleep(3)
left = []
left += [x for x in STACKS + ([TOOLKIT] if a.with_bootstrap else []) if stack_exists(x)]
ctl = s.client("bedrock-agentcore-control")
left += [r["agentRuntimeName"] for r in ctl.list_agent_runtimes()["agentRuntimes"] if r["agentRuntimeName"] in ("claims_policy_mcp", "damage_repair_mcp")]
left += [f"lambda {f['FunctionName']}" for f in s.client("lambda").list_functions()["Functions"] if f["FunctionName"].startswith(("claims-workbench", "ClaimsWb-"))]
left += [f"user pool {p['Name']}" for p in s.client("cognito-idp").list_user_pools(MaxResults=60)["UserPools"] if p["Name"].startswith("claims-workbench")]
left += [f"table {t}" for t in s.client("dynamodb").list_tables()["TableNames"] if t.startswith("claims-workbench")]
left += [f"distribution {d['Id']}" for d in (s.client("cloudfront").list_distributions()["DistributionList"].get("Items") or []) if d.get("Comment") in ("Claims Intelligence Workbench", "Class Insights")]
left += [f"web acl {w['Name']}" for w in s.client("wafv2", region_name="us-east-1").list_web_acls(Scope="CLOUDFRONT")["WebACLs"] if w["Name"] in ("claims-workbench-web", "claims-insights-web")]
left += [f"dashboard {d['DashboardName']}" for d in s.client("cloudwatch").list_dashboards(DashboardNamePrefix="claims-workbench")["DashboardEntries"]]
left += [f"alarm {x['AlarmName']}" for x in s.client("cloudwatch").describe_alarms(AlarmNamePrefix="claims-workbench")["MetricAlarms"]]
left += [f"record {r['Name']}" for r in r53.list_resource_record_sets(HostedZoneId=zid)["ResourceRecordSets"] if r["Name"].rstrip(".") in (CFG["siteHostname"], CFG["insightsHostname"])]
left += [f"cert {c['DomainName']}" for c in acm.list_certificates()["CertificateSummaryList"] if c["DomainName"] in (CFG["siteHostname"], CFG["insightsHostname"])]
if a.with_bootstrap:
    left += [f"bucket {b['Name']}" for b in s.client("s3").list_buckets()["Buckets"] if b["Name"].startswith(f"cdk-{QUALIFIER}-")]
for prefix in ("/aws/lambda/claims-workbench", "/aws/lambda/claims-insights"):
    for page in logs.get_paginator("describe_log_groups").paginate(logGroupNamePrefix=prefix):
        left += [g["logGroupName"] for g in page["logGroups"]]
left += [f"bucket {b['Name']}" for b in s.client("s3").list_buckets()["Buckets"] if b["Name"].startswith(("claims-insights-", "claimsinsights-", "claimswb-web-", "claimswb-knowledgebase-"))]
left += [f"appconfig application {i}" for i in appconfig_apps()]
left += [f"knowledge base {k['name']}" for k in s.client("bedrock-agent").list_knowledge_bases()["knowledgeBaseSummaries"] if k["name"] == "claims-handling-manual"]
left += [f"vector bucket {b['vectorBucketName']}" for b in s.client("s3vectors").list_vector_buckets()["vectorBuckets"] if b["vectorBucketName"].startswith("claims-wb-kb-")]
left += [f"appconfig strategy {x['Name']}" for x in ac.list_deployment_strategies()["Items"] if x["Name"] == "claims-wb-instant"]
for alias in s.client("kms").list_aliases()["Aliases"]:
    if alias["AliasName"] == "alias/claims-workbench-data":
        left.append("kms alias/claims-workbench-data")
if left:
    print("  ✗ still present:\n    " + "\n    ".join(left))
    sys.exit(1)
print("  ✓ nothing left (the KMS key stays PendingDeletion for 7 days, the AWS minimum)")
