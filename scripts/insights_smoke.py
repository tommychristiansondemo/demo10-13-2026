"""End-to-end test of the DEPLOYED Class Insights app through https://<insightsHostname>.

    .venv/bin/python scripts/insights_smoke.py [--no-chat]
"""
import argparse
import hashlib
import json
import sys

import boto3
import httpx

from outputs import CDK, output
from smoke_test_auth import token

ap = argparse.ArgumentParser()
ap.add_argument("--no-chat", action="store_true")
args = ap.parse_args()
SITE = f"https://{CDK['insightsHostname']}"
results: list[bool] = []
bodies: list[str] = []


def check(cond, label: str, detail: str = "") -> bool:
    results.append(bool(cond))
    print(f"  {'✓' if cond else '✗'} {label}" + (f"  [{detail}]" if detail and not cond else ""))
    return bool(cond)


http = httpx.Client(timeout=60)
print(f"Class Insights smoke test against {SITE}")
r = http.get(SITE + "/")
check(r.status_code == 200 and "Class Insights" in r.text, "site serves the SPA from S3 over HTTPS")
check("content-security-policy" in r.headers and "strict-transport-security" in r.headers, "security headers present")
check(http.get(SITE + "/reasoning").status_code == 200, "SPA deep link rewritten at the edge")
cfg = http.get(SITE + "/config.json").json()
check(cfg.get("userPoolClientId") and cfg.get("workbenchUrl") == f"https://{CDK['siteHostname']}", "config.json: own Cognito client + link back to the Workbench")
check(http.get(SITE + "/api/insights/health").json().get("ok") is True, "insights API health through CloudFront")
check(http.get(SITE + "/api/insights/inventory").status_code == 401, "unauthenticated request rejected (401)")
for fn in ("claims-insights-api", "claims-insights-chat"):
    url = boto3.client("lambda").get_function_url_config(FunctionName=fn)["FunctionUrl"]
    check(http.get(url).status_code == 403, f"{fn} Function URL not callable directly (OAC only)")

tok = token("claims.analyst")
H = {"x-auth-token": tok}
g = lambda p, **kw: http.get(SITE + p, headers=H, **kw)  # noqa: E731
r = g("/api/insights/me")
check(r.status_code == 200 and r.json().get("username") == "claims.analyst", "Workbench user signs in to Class Insights (shared user pool)")
k = g("/api/insights/knowledge").json()
bodies.append(json.dumps(k))
check("Project knowledge" in k.get("markdown", "") and k.get("bucket", "").startswith("claims-insights-knowledge-"), "projectknowledge.md served from the knowledge bucket")
check("Live inventory (generated" in k.get("markdown", ""), "knowledge file contains the generated live-inventory section")
inv = g("/api/insights/inventory").json()
bodies.append(json.dumps(inv))
check(inv.get("totals", {}).get("distinctResourceTypes", 0) > 20 and inv["totals"]["stacks"] == 8, "live inventory: 8 stacks, resource types counted", json.dumps(inv.get("totals")))
check([x["status"] for x in inv.get("agentCoreRuntimes", [])] == ["READY", "READY"], "live inventory: both AgentCore runtimes READY")
check(len(g("/api/insights/logs/sources").json().get("sources", [])) == 6, "6 allow-listed log sources")
logs = http.get(SITE + "/api/insights/logs", headers=H, params={"source": "workbench-api", "minutes": "1440", "filter": '{ $.log_type = "mcp_tool_call" }'}).json()
bodies.append(json.dumps(logs))
check(logs.get("matched", 0) > 0, "logs explorer finds MCP tool calls in the Workbench API log", json.dumps(logs)[:200])
check(g("/api/insights/logs?source=not-allowed").status_code == 400, "non-allow-listed log source refused (400)")
rs = g("/api/insights/reasoning?app=claims-workbench&minutes=1440&limit=3").json()
bodies.append(json.dumps(rs))
wb_reasoning = [c for run in rs.get("runs", []) for c in run["calls"] if c.get("reasoning")]
check(rs.get("runs") and any(run.get("prompt", {}).get("systemPrompt") for run in rs["runs"]), "Workbench reasoning log: llm_prompt with the full system prompt")
check(wb_reasoning, "Workbench reasoning log: llm_call lines carry the model's extended-thinking text")
check("values" in g("/api/insights/metrics?hours=24").json(), "metrics endpoint")
mr = g("/api/insights/models").json()
bodies.append(json.dumps(mr))
check(len(mr.get("ranking", [])) == 8 and mr.get("activeModel", {}).get("modelId"), "model routing from AppConfig: active model + ranking of 8 LLMs", json.dumps(mr)[:200])
check(inv.get("modelRouting", {}).get("activeModel"), "live inventory includes the Workbench's current LLM")
kbi = inv.get("knowledgeBase") or {}
check(kbi.get("status") == "ACTIVE" and (kbi.get("lastIngestion") or {}).get("status") == "COMPLETE" and kbi.get("vectorStore") == "S3_VECTORS",
      "live inventory: Bedrock Knowledge Base ACTIVE on S3 Vectors, last ingestion COMPLETE", json.dumps(kbi)[:300])
lc = g("/api/insights/costs/llm", params={"app": "all", "minutes": 1440, "limit": 50}).json()
bodies.append(json.dumps(lc))
logged = [c for c in lc.get("calls", []) if c.get("costSource") == "logged at call time"]
check(lc.get("totals", {}).get("calls", 0) > 0 and lc["totals"]["costUsd"] > 0 and all(c["costUsd"] is not None for c in lc["calls"]),
      f"every LLM call is priced ({lc.get('totals', {}).get('calls')} calls, ${lc.get('totals', {}).get('costUsd')} in 24 h)", json.dumps(lc.get("totals")))
check(logged and lc.get("byModel"), "calls carry the cost logged at call time; per-model totals", f"{len(logged)} logged")
ce = g("/api/insights/costs/explorer").json()
bodies.append(json.dumps(ce))
check("totalUsd" in ce.get("monthToDate", {}) and ce.get("daily") and not ce.get("errors"), f"Cost Explorer summary (month to date ${ce.get('monthToDate', {}).get('totalUsd')}, LLM ${ce.get('monthToDate', {}).get('llmUsd')})", json.dumps(ce.get("errors"))[:300])

if not args.no_chat:
    q = "How many distinct AWS resource types are deployed right now, and which LLM does each app use? Be brief."
    body = json.dumps({"conversationId": "smoke-test-insights", "messages": [{"role": "user", "content": q}]})
    events = []
    with http.stream("POST", SITE + "/api/insights/chat", headers={**H, "content-type": "application/json", "x-amz-content-sha256": hashlib.sha256(body.encode()).hexdigest()}, content=body, timeout=240) as s:
        check(s.status_code == 200, "chat stream opened", str(s.status_code))
        for line in s.iter_lines():
            if line.strip():
                events.append(json.loads(line))
    text = "".join(e.get("text", "") for e in events if e["type"] == "text")
    bodies.append(text)
    done = next((e for e in events if e["type"] == "done"), None)
    check(done and not any(e["type"] == "error" for e in events), "chat completed", json.dumps([e for e in events if e["type"] == "error"])[:300])
    check(any(e["type"] == "reasoning" for e in events), "chat streamed the model's reasoning")
    check(any(e["type"] == "tool_call" and e["name"] == "get_live_inventory" for e in events), "chat used the live inventory tool")
    check("sonnet" in text.lower() and str(inv["totals"]["distinctResourceTypes"]) in text, "answer names the model and the live resource-type count", text[:300])
    if done:
        import time  # noqa: E402
        for _ in range(12):  # CloudWatch Logs ingestion takes a few seconds
            rs = g(f"/api/insights/reasoning?app=class-insights&minutes=60&runId={done['requestId']}").json()
            calls = [c for run in rs.get("runs", []) for c in run["calls"]]
            if calls:
                break
            time.sleep(5)
        check(calls and any(c.get("reasoning") for c in calls), "chatbot's own reasoning is in the reasoning log", json.dumps(rs)[:200])
        check(calls and all(isinstance(c.get("costUsd"), (int, float)) and c["costUsd"] > 0 for c in calls), "chatbot logs the cost of each of its own calls", json.dumps([c.get("costUsd") for c in calls]))

blob = "\n".join(bodies)
import re  # noqa: E402
check(not re.search(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b|aws_secret_access_key|eyJraWQ", blob), "no credentials or tokens in any response")
print(f"\n{sum(results)}/{len(results)} Class Insights checks passed")
sys.exit(0 if all(results) else 1)
