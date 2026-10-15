"""Proves the deployed app does not depend on this workstation: every hop from the browser to Bedrock and both MCP
runtimes lives in AWS, and nothing in the deployed configuration points back at a laptop, a tunnel or a local port.

    .venv/bin/python scripts/verify_independence.py

The final proof is physical: shut this machine down and use https://www.awsteach.com from a phone. This script checks
everything that would make that fail.
"""
import json
import re
import socket
import sys
import urllib.request

import boto3

from outputs import CDK, output, runtime_arns, site_url

G, R, B, X = "\033[32m", "\033[31m", "\033[1m", "\033[0m"
results: list[bool] = []
# Anything that would mean "the app phones home to a workstation".
LOCAL = re.compile(r"localhost|127\.0\.0\.1|0\.0\.0\.0|\b10\.\d+\.\d+\.\d+|\b192\.168\.|\b172\.(1[6-9]|2\d|3[01])\.|ngrok|"
                   r"trycloudflare|localtunnel|\.local\b|:5173|:8787|:800[12]", re.I)
SECRET = re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b")


def check(label: str, cond: bool, detail: str = "") -> None:
    results.append(bool(cond))
    print(f"  {G + '✓' if cond else R + '✗'}{X} {label}{f'  ({detail})' if detail else ''}")


def fetch(url: str) -> str:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "independence-check"}), timeout=20) as r:
        return r.read().decode("utf-8", "replace")


host = CDK["siteHostname"]
lam = boto3.client("lambda")
ac = boto3.client("bedrock-agentcore-control")
cf = boto3.client("cloudfront")
idp = boto3.client("cognito-idp")
account = boto3.client("sts").get_caller_identity()["Account"]

print(f"{B}API + orchestrator (Lambda){X}")
fn = lam.get_function_configuration(FunctionName=output("ClaimsWb-Api", "ApiFunctionName"))
env = fn.get("Environment", {}).get("Variables", {})
blob = json.dumps(env)
check("no local/tunnel addresses in environment", not LOCAL.search(blob), LOCAL.search(blob).group(0) if LOCAL.search(blob) else "")
check("no AWS access keys in environment (runs on its IAM role)", not SECRET.search(blob))
check("LOCAL_DEV bypass is off", "LOCAL_DEV" not in env)
check("MCP endpoints are AgentCore runtime ARNs, not URLs",
      all(env.get(k, "").startswith("arn:aws:bedrock-agentcore:") for k in ("CLAIMS_MCP_RUNTIME_ARN", "DAMAGE_MCP_RUNTIME_ARN"))
      and not any(k.endswith("_MCP_URL") for k in env))
check("execution role is an IAM role in this account", fn["Role"].startswith(f"arn:aws:iam::{account}:role/"), fn["Role"].split("/")[-1])

print(f"\n{B}MCP servers (AgentCore Runtime){X}")
for name, arn in runtime_arns().items():
    rt = ac.get_agent_runtime(agentRuntimeId=arn.split("/")[-1])
    uri = rt.get("agentRuntimeArtifact", {}).get("containerConfiguration", {}).get("containerUri", "")
    check(f"{name}: READY, image hosted in ECR in this account",
          rt["status"] == "READY" and uri.startswith(f"{account}.dkr.ecr."), f"{rt['status']}, {uri.split('/')[-1][:40]}")

print(f"\n{B}Bedrock Knowledge Base{X}")
kb_id = output("ClaimsWb-KnowledgeBase", "KnowledgeBaseId")
ba = boto3.client("bedrock-agent")
kbd = ba.get_knowledge_base(knowledgeBaseId=kb_id)["knowledgeBase"]
ds = ba.get_data_source(knowledgeBaseId=kb_id, dataSourceId=output("ClaimsWb-KnowledgeBase", "DataSourceId"))["dataSource"]
check("KB is ACTIVE, documents in S3 and vectors in S3 Vectors in this account",
      kbd["status"] == "ACTIVE" and ds["dataSourceConfiguration"]["s3Configuration"]["bucketArn"].startswith("arn:aws:s3:::")
      and f":{account}:" in kbd["storageConfiguration"]["s3VectorsConfiguration"]["indexArn"], kbd["storageConfiguration"]["type"])
check("API Lambda knows the KB id (retrieval runs on its IAM role)", env.get("KNOWLEDGE_BASE_ID") == kb_id)

print(f"\n{B}Edge (CloudFront, DNS, Cognito){X}")
dist = cf.get_distribution(Id=output("ClaimsWb-Web", "DistributionId"))["Distribution"]["DistributionConfig"]
origins = [o["DomainName"] for o in dist["Origins"]["Items"]]
check("CloudFront origins are only S3 and the Lambda Function URL",
      all(o.endswith(".amazonaws.com") or o.endswith(".on.aws") for o in origins), ", ".join(origins))
addrs = {a[4][0] for a in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)}
check(f"{host} resolves publicly", bool(addrs) and not any(LOCAL.search(a) for a in addrs), ", ".join(sorted(addrs))[:80])
client = idp.describe_user_pool_client(UserPoolId=output("ClaimsWb-Foundation", "UserPoolId"),
                                       ClientId=output("ClaimsWb-Foundation", "UserPoolClientId"))["UserPoolClient"]
urls = client.get("CallbackURLs", []) + client.get("LogoutURLs", [])
check("Cognito sign-in returns only to the public HTTPS site", all(u.startswith(f"https://{host}") for u in urls), ", ".join(sorted(set(urls))))

print(f"\n{B}What the browser downloads{X}")
cfg_text = fetch(f"{site_url()}/config.json")
cfg = json.loads(cfg_text)
check("config.json has no local-dev flag or local URLs", not cfg.get("localDev") and not LOCAL.search(cfg_text))
html = fetch(site_url() + "/")
bundles = re.findall(r'src="(/assets/[^"]+\.js)"', html)
js = "".join(fetch(site_url() + b) for b in bundles)
hit = LOCAL.search(js)
check("JavaScript bundle never calls a local address", bool(bundles) and not hit, hit.group(0) if hit else f"{len(bundles)} bundle(s)")
health = json.loads(fetch(f"{site_url()}/api/health"))
check("public /api/health answers through CloudFront -> Lambda", health.get("ok") is True or health.get("status") == "ok", json.dumps(health)[:80])

print(f"\n{B}Class Insights{X}")
try:
    ins_host = CDK["insightsHostname"]
    idist = cf.get_distribution(Id=output("ClaimsInsights", "InsightsDistributionId"))["Distribution"]["DistributionConfig"]
    iorigins = [o["DomainName"] for o in idist["Origins"]["Items"]]
    check("Insights CloudFront origins are only S3 and Lambda Function URLs", all(o.endswith(".amazonaws.com") or o.endswith(".on.aws") for o in iorigins), ", ".join(iorigins))
    for fname in ("claims-insights-api", "claims-insights-chat"):
        ienv = json.dumps(lam.get_function_configuration(FunctionName=fname).get("Environment", {}).get("Variables", {}))
        check(f"{fname}: no local addresses or keys in environment", not LOCAL.search(ienv) and not SECRET.search(ienv))
    icfg = fetch(f"https://{ins_host}/config.json")
    check("Insights config.json has no local URLs", not LOCAL.search(icfg))
    ih = json.loads(fetch(f"https://{ins_host}/api/insights/health"))
    check("public Insights /api/insights/health answers through CloudFront -> Lambda", ih.get("ok") is True)
except KeyError:
    print("  - ClaimsInsights not deployed")

print(f"\n{sum(results)}/{len(results)} independence checks passed")
if all(results):
    print("Nothing deployed depends on this workstation. Final proof: shut it down and open the site from a phone.")
sys.exit(0 if all(results) else 1)
