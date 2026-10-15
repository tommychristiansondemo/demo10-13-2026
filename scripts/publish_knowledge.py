"""Publish docs/knowledge/projectknowledge.md to the Class Insights knowledge bucket (run after every deployment).

    .venv/bin/python scripts/publish_knowledge.py [--dry-run]

Regenerates the "Live inventory" section between the LIVE-INVENTORY markers from CloudFormation (stacks, resource
counts by type, AWS services) plus AgentCore runtime and Lambda configuration, then uploads the file. The bucket is
versioned, so every published revision is kept. The chatbot picks up the new file within 30 s, with no redeploy.
"""
import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from outputs import ROOT, output

STACKS = ["ClaimsWb-Foundation", "ClaimsWb-McpRuntimes", "ClaimsWb-KnowledgeBase", "ClaimsWb-Api", "ClaimsWb-Web", "ClaimsWb-Observability", "ClaimsInsights", "ClaimsWb-CDKToolkit"]
FUNCTIONS = ["claims-workbench-api", "claims-workbench-signup", "claims-insights-api", "claims-insights-chat"]
SRC = ROOT / "docs/knowledge/projectknowledge.md"
START, END = "<!-- LIVE-INVENTORY:START -->", "<!-- LIVE-INVENTORY:END -->"

ap = argparse.ArgumentParser()
ap.add_argument("--dry-run", action="store_true", help="print the generated section instead of uploading")
a = ap.parse_args()

cf = boto3.client("cloudformation")
total = Counter()
rows = []
for name in STACKS:
    try:
        st = cf.describe_stacks(StackName=name)["Stacks"][0]
    except ClientError:
        rows.append(f"| `{name}` | not deployed | 0 |")
        continue
    types = Counter()
    for page in cf.get_paginator("list_stack_resources").paginate(StackName=name):
        types.update(r["ResourceType"] for r in page["StackResourceSummaries"])
    total.update(types)
    rows.append(f"| `{name}` | {st['StackStatus']} | {sum(types.values())} |")

# Real AWS services only: skip CDK metadata and Custom:: resources (CDK helper Lambdas back those).
services = sorted({t.split("::")[1] for t in total if t.startswith("AWS::") and t != "AWS::CDK::Metadata"})
ac = boto3.client("bedrock-agentcore-control")
runtimes = []
for r in ac.list_agent_runtimes()["agentRuntimes"]:
    if r["agentRuntimeName"] in ("claims_policy_mcp", "damage_repair_mcp"):
        d = ac.get_agent_runtime(agentRuntimeId=r["agentRuntimeId"])
        runtimes.append(f"| `{d['agentRuntimeName']}` | {d['status']} | v{d['agentRuntimeVersion']} | {d.get('protocolConfiguration', {}).get('serverProtocol')} | `{d['agentRuntimeArn']}` |")
lam = boto3.client("lambda")
fns = []
for f in FUNCTIONS:
    try:
        c = lam.get_function_configuration(FunctionName=f)
        env = c.get("Environment", {}).get("Variables", {})
        model = ('`' + env['MODEL_ID'] + '`') if 'MODEL_ID' in env else 'chosen at run time from AWS AppConfig (see Model routing)' if 'APPCONFIG_SELECTION_PROFILE_ID' in env else '-'
        fns.append(f"| `{f}` | {c['Runtime']} {c['Architectures'][0]} | {c['MemorySize']} MB / {c['Timeout']} s | {model} |")
    except ClientError:
        fns.append(f"| `{f}` | not deployed | | |")




def model_routing() -> list[str]:
    """Current AppConfig model selection + catalog, rendered with the same scoring the app uses (via tsx)."""
    ac = boto3.client("appconfig")
    app = next((x for x in ac.list_applications()["Items"] if x["Name"] == "claims-workbench"), None)
    if not app:
        return ["Model routing: AppConfig application not deployed."]
    env = next(x for x in ac.list_environments(ApplicationId=app["Id"])["Items"] if x["Name"] == "live")
    profiles = {x["Name"]: x["Id"] for x in ac.list_configuration_profiles(ApplicationId=app["Id"])["Items"]}
    deps = ac.list_deployments(ApplicationId=app["Id"], EnvironmentId=env["Id"], MaxResults=50)["Items"]

    def deployed(name: str) -> dict:
        d = next(x for x in deps if x["ConfigurationName"] == name and x["State"] == "COMPLETE")
        v = ac.get_hosted_configuration_version(ApplicationId=app["Id"], ConfigurationProfileId=profiles[name], VersionNumber=int(d["ConfigurationVersion"]))
        return json.loads(v["Content"].read())

    sel, cat = deployed("model-selection"), deployed("model-catalog")
    ranking = json.loads(subprocess.run(
        ["npx", "tsx", "-e", "import { rankModels } from './services/api/src/model-routing.ts';"
         f"console.log(JSON.stringify(rankModels({json.dumps(cat)}, {json.dumps(sel['weights'])}, {sel['qualityFloor']})))"],
        cwd=ROOT, capture_output=True, text=True, check=True).stdout)
    names = {m["key"]: m for m in cat["models"]}
    w = sel["weights"]
    return [
        f"### Model routing (AWS AppConfig, as of publishing)",
        "",
        f"**Active Workbench model:** {names[sel['activeModel']]['name']} (`{names[sel['activeModel']]['modelId']}`). "
        f"**Preferences:** quality {w['quality']}%, cost {w['cost']}%, latency {w['latency']}% (set by {sel['updatedBy']} at {sel['updatedAt']}). "
        f"Students change this at runtime, so for the current value ask the chatbot (tool `get_model_routing`).",
        "",
        "| Rank | Model | Provider | Score | Quality / Cost / Latency sub-scores | Benchmark quality | $ per analysis | s per analysis | List price in/out per 1M |",
        "|---|---|---|---|---|---|---|---|---|",
        *[f"| {r['rank']} | {r['name']} | {r['provider']} | {r['total']} | {r['scores']['quality']} / {r['scores']['cost']} / {r['scores']['latency']} | "
          f"{names[r['key']]['benchmark']['quality']} | ${r['avgCostUsd']:.4f} | {r['avgLatencySec']} | "
          f"${names[r['key']]['pricing']['inputPerMTok']} / ${names[r['key']]['pricing']['outputPerMTok']} |" for r in ranking],
    ]


now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
section = "\n".join([
    START,
    f"## 7. Live inventory (generated {now} from CloudFormation)",
    "",
    f"**Totals:** {len([r for r in rows if 'not deployed' not in r])} stacks · **{sum(total.values())} resources** · "
    f"**{len(total)} distinct CloudFormation resource types** · **{len(services)} AWS services**.",
    "",
    f"AWS services (CloudFormation namespaces): {', '.join(services)}.",
    "",
    "| Stack | Status | Resources |", "|---|---|---|", *rows,
    "",
    "| Resource type | Count |", "|---|---|", *[f"| `{t}` | {n} |" for t, n in sorted(total.items(), key=lambda x: (-x[1], x[0]))],
    "",
    "| AgentCore runtime | Status | Version | Protocol | ARN |", "|---|---|---|---|---|", *runtimes,
    "",
    "| Lambda function | Runtime | Memory / timeout | Model |", "|---|---|---|---|", *fns,
    "",
    *model_routing(),
    "",
    "Also used, without CloudFormation resources of their own: Amazon Bedrock (model invocation through inference "
    "profiles), Amazon Bedrock AgentCore data plane (InvokeAgentRuntime), AWS STS, AWS Secrets Manager (instructor "
    "passwords, created by scripts/seed_users.py), CloudWatch metrics (Embedded Metric Format), AWS X-Ray traces, AWS AppConfig data plane "
    "(GetLatestConfiguration), AWS Cost Explorer (Class Insights Costs page) and the AWS Price List API (model prices, at benchmark time).",
    "",
    "Counts include the CDK bootstrap stack and CDK helper resources (custom-resource Lambdas, IAM roles, policies). "
    "For counts as of right now, ask the chatbot (tool `get_live_inventory`) or open the Live inventory page.",
    END,
])
text = SRC.read_text()
if START not in text or END not in text:
    sys.exit("LIVE-INVENTORY markers missing in projectknowledge.md")
published = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: section, text, flags=re.S)
if a.dry_run:
    print(section)
    sys.exit(0)
bucket = output("ClaimsInsights", "KnowledgeBucket")
r = boto3.client("s3").put_object(Bucket=bucket, Key="projectknowledge.md", Body=published.encode(), ContentType="text/markdown; charset=utf-8")
print(f"  ✓ published s3://{bucket}/projectknowledge.md ({len(published):,} chars, version {r.get('VersionId', '-')}): "
      f"{sum(total.values())} resources, {len(total)} resource types, {len(services)} services")
