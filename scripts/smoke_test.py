"""End-to-end test of the DEPLOYED application through https://<site> (CloudFront -> WAF -> Lambda -> Bedrock -> 2 MCP runtimes).

    .venv/bin/python scripts/smoke_test.py [--claim CLM-24817] [--no-analysis]
"""
import argparse
import hashlib
import json
import sys
import time

import boto3
import httpx

from outputs import output, runtime_arns, site_url
from smoke_test_auth import token

ap = argparse.ArgumentParser()
ap.add_argument("--claim", default="CLM-24817")
ap.add_argument("--no-analysis", action="store_true")
ap.add_argument("--no-routing", action="store_true", help="skip the model-switch test (it changes the live model for ~1 minute)")
args = ap.parse_args()

SITE = site_url()
results: list[tuple[bool, str]] = []


def check(cond: bool, label: str, detail: str = "") -> bool:
    results.append((bool(cond), label))
    print(f"  {'✓' if cond else '✗'} {label}" + (f"  [{detail}]" if detail and not cond else ""))
    return bool(cond)


def post_headers(tok: str, body: str) -> dict:
    return {"x-auth-token": tok, "content-type": "application/json", "x-amz-content-sha256": hashlib.sha256(body.encode()).hexdigest()}


http = httpx.Client(timeout=60, follow_redirects=False)
print(f"Smoke test against {SITE}")

# --- edge -------------------------------------------------------------------------------------
r = http.get(SITE + "/")
check(r.status_code == 200 and "Claims Intelligence Workbench" in r.text, "site serves the SPA over HTTPS")
check("content-security-policy" in r.headers and "strict-transport-security" in r.headers, "security headers present")
r = http.get(SITE + "/claims/CLM-24817")
check(r.status_code == 200 and "<div id=\"root\">" in r.text, "SPA deep link rewritten at the edge")
cfg = http.get(SITE + "/config.json").json()
check(cfg.get("userPoolClientId") and cfg.get("cognitoDomain"), "runtime config.json published")
check(http.get(SITE + "/api/health").json().get("ok") is True, "API health through CloudFront")
r = http.get(SITE + "/api/claims")
check(r.status_code == 401 and r.headers.get("content-type", "").startswith("application/json"), "unauthenticated API call rejected with JSON 401")
fn_name = output("ClaimsWb-Api", "ApiFunctionName")
fn_url = boto3.client("lambda").get_function_url_config(FunctionName=fn_name)["FunctionUrl"]
check(http.get(fn_url + "api/health").status_code == 403, "Function URL not callable directly (IAM / OAC only)")

# --- identity ---------------------------------------------------------------------------------
analyst, supervisor = token("claims.analyst"), token("claims.supervisor")
me = http.get(SITE + "/api/me", headers={"x-auth-token": analyst}).json()
check(me.get("isAnalyst") and not me.get("isSupervisor"), "analyst token verified, groups mapped", json.dumps(me))
me = http.get(SITE + "/api/me", headers={"x-auth-token": supervisor}).json()
check(me.get("isSupervisor"), "supervisor token verified", json.dumps(me))

# --- student self-registration (same public Cognito API the Create account form uses) ----------
idp = boto3.client("cognito-idp")
pool_id, client_id = output("ClaimsWb-Foundation", "UserPoolId"), output("ClaimsWb-Foundation", "UserPoolClientId")
suffix = str(int(time.time()))
for user_type, want_sup in (("analyst", False), ("supervisor", True)):
    uname = f"smoke-{user_type}-{suffix}"
    try:
        idp.sign_up(ClientId=client_id, Username=uname, Password="abc123", ClientMetadata={"role": user_type})
        tok = idp.initiate_auth(ClientId=client_id, AuthFlow="USER_AUTH", AuthParameters={
            "USERNAME": uname, "PASSWORD": "abc123", "PREFERRED_CHALLENGE": "PASSWORD"})["AuthenticationResult"]["AccessToken"]
        me = http.get(SITE + "/api/me", headers={"x-auth-token": tok}).json()
        check(me.get("isAnalyst") and me.get("isSupervisor") == want_sup,
              f"self sign-up as {user_type}: 6-char password, no email, auto-confirmed, correct group", json.dumps(me))
    except Exception as e:  # noqa: BLE001
        check(False, f"self sign-up as {user_type}", str(e)[:200])
    finally:
        try:
            idp.admin_delete_user(UserPoolId=pool_id, Username=uname)
        except idp.exceptions.UserNotFoundException:
            pass
try:
    idp.sign_up(ClientId=client_id, Username=f"smoke-bad-{suffix}", Password="abc123", ClientMetadata={"role": "admin"})
    check(False, "unknown user type rejected at sign-up")
    idp.admin_delete_user(UserPoolId=pool_id, Username=f"smoke-bad-{suffix}")
except idp.exceptions.UserLambdaValidationException:
    check(True, "unknown user type rejected at sign-up")

# --- MCP-backed reads -------------------------------------------------------------------------
t0 = time.time()
claims = http.get(SITE + "/api/claims", headers={"x-auth-token": analyst}).json()
check(len(claims.get("claims", [])) == 8, f"queue: 8 claims via claims_policy.list_claims ({time.time() - t0:.1f}s)", json.dumps(claims)[:300])
detail = http.get(SITE + f"/api/claims/{args.claim}", headers={"x-auth-token": analyst}).json()
via = detail.get("via", [])
check(len(via) == 6 and all(v["ok"] for v in via) and {v["server"] for v in via} == {"claims_policy", "damage_repair"},
      "claim detail: 6 tool calls across both MCP servers", json.dumps(via))
servers = http.get(SITE + "/api/mcp/servers", headers={"x-auth-token": analyst}).json()["servers"]
arns = runtime_arns()
check([s["ok"] for s in servers] == [True, True] and [len(s["tools"]) for s in servers] == [5, 5], "tools/list on both runtimes: 5 + 5 tools")
check({s["id"]: s["runtimeArn"] for s in servers} == arns, "API uses the two deployed runtime ARNs")

# --- AI analysis + approval -------------------------------------------------------------------
if not args.no_analysis:
    t0 = time.time()
    events = []
    with http.stream("POST", SITE + f"/api/claims/{args.claim}/analyze", headers=post_headers(analyst, "{}"), content="{}", timeout=300) as s:
        check(s.status_code == 200, "analysis stream opened", str(s.status_code))
        for line in s.iter_lines():
            if line.strip():
                events.append(json.loads(line))
    kinds = [e["type"] for e in events]
    run = next((e["run"] for e in events if e["type"] == "run_completed"), None)
    errors = [e["message"] for e in events if e["type"] == "error"]
    check(run and run["status"] == "PENDING_APPROVAL", f"analysis completed in {time.time() - t0:.0f}s", "; ".join(errors) or str(kinds[-5:]))
    if run:
        v = run["validation"]
        rec = run["recommendation"]
        check({"claims_policy", "damage_repair"} <= set(v["serversUsed"]), f"agent used both MCP servers ({v['toolCalls']} tool calls)")
        kb_hits = [e for e in run["evidence"] if e["server"] == "knowledge_base" and e["ok"]]
        check(kb_hits and any(p["text"] for e in kb_hits for p in e["result"]["passages"]), f"agent searched the Bedrock Knowledge Base ({len(kb_hits)} searches) and cited the manual",
              json.dumps([e["args"] for e in kb_hits])[:200])
        check(any(e["tool"] == "reconcile_estimate" and e["ok"] for e in run["evidence"]), "agent passed the estimate across the MCP boundary (reconcile_estimate)")
        check(not v["invalidCitations"], "no invalid citations", str(v["invalidCitations"]))
        print(f"    disposition={rec['disposition']} confidence={rec['confidence']} usage={run['usage']}")
        print(f"    headline: {rec['headline']}")
        if args.claim == "CLM-24817":
            check(rec["disposition"] == "APPROVE_REPAIR_WITH_ADJUSTMENTS", "demo claim disposition is APPROVE_REPAIR_WITH_ADJUSTMENTS", rec["disposition"])
            check(any(a["owner"] == "SUBROGATION" for a in rec["next_actions"]), "demo claim includes a subrogation action")
        path = f"/api/claims/{args.claim}/runs/{run['runId']}/decision"
        body = json.dumps({"decision": "APPROVED", "comment": "smoke test"})
        r = http.post(SITE + path, headers=post_headers(analyst, body), content=body)
        check(r.status_code == 403, "analyst cannot approve (403)", str(r.status_code))
        r = http.post(SITE + path, headers=post_headers(supervisor, body), content=body)
        check(r.status_code == 200 and r.json()["status"] == "APPROVED", "supervisor approves (200)", r.text[:200])
        r = http.post(SITE + path, headers=post_headers(supervisor, body), content=body)
        check(r.status_code == 409, "second decision rejected (409, first decision wins)", str(r.status_code))
        runs = http.get(SITE + f"/api/claims/{args.claim}/runs", headers={"x-auth-token": analyst}).json()["runs"]
        check(runs and runs[0]["runId"] == run["runId"], "run persisted in DynamoDB")

# --- model routing (AWS AppConfig) --------------------------------------------------------------
ac = boto3.client("appconfig")
AC = {k: output("ClaimsWb-Api", k) for k in ("AppConfigApplicationId", "AppConfigEnvironmentId", "AppConfigSelectionProfileId")}


def restore_selection(sel: dict) -> None:
    """Put back the exact previous selection (the test harness writes AppConfig directly, like the API Lambda does)."""
    v = ac.create_hosted_configuration_version(ApplicationId=AC["AppConfigApplicationId"], ConfigurationProfileId=AC["AppConfigSelectionProfileId"],
                                               Content=json.dumps(sel, indent=2).encode(), ContentType="application/json",
                                               Description=f"smoke test: restored the selection from before the test ({sel['updatedBy']})")
    strategy = next(x["Id"] for x in ac.list_deployment_strategies()["Items"] if x["Name"] == "claims-wb-instant")
    for _ in range(60):
        try:
            d = ac.start_deployment(ApplicationId=AC["AppConfigApplicationId"], EnvironmentId=AC["AppConfigEnvironmentId"], DeploymentStrategyId=strategy,
                                    ConfigurationProfileId=AC["AppConfigSelectionProfileId"], ConfigurationVersion=str(v["VersionNumber"]),
                                    Description=f"smoke test: restored {sel['activeModel']} with weights {sel['weights']}")
            break
        except ac.exceptions.ConflictException:
            time.sleep(1)
    while ac.get_deployment(ApplicationId=AC["AppConfigApplicationId"], EnvironmentId=AC["AppConfigEnvironmentId"], DeploymentNumber=d["DeploymentNumber"])["State"] != "COMPLETE":
        time.sleep(1)


models = http.get(SITE + "/api/models", headers={"x-auth-token": analyst}).json()
original = models["selection"]
w = original["weights"]
check(len(models["catalog"]["models"]) == 8 and len(models["ranking"]) == 8, "model catalog (8 LLMs) and ranking served from AppConfig", models.get("source", ""))
check(w["quality"] + w["cost"] + w["latency"] == 100, f"configured weights sum to 100 (quality {w['quality']} / cost {w['cost']} / latency {w['latency']})")
print(f"    live model: {original['activeModel']}; ranking: " + ", ".join(f"{r['rank']}. {r['key']} {r['total']}" for r in models["ranking"]))
bad = json.dumps({"weights": {"quality": 50, "cost": 30, "latency": 30}})
r = http.post(SITE + "/api/models/evaluate", headers=post_headers(analyst, bad), content=bad)
check(r.status_code == 400 and "100" in r.text, "weights that do not sum to 100 are rejected (400)", r.text[:120])
if not args.no_routing:
    # The router only moves to models that meet the quality floor (Llama 4 is in the catalog but below it).
    floor = original.get("qualityFloor", 70)
    cheapest = min((m for m in models["catalog"]["models"] if m["benchmark"]["quality"] >= floor), key=lambda m: m["benchmark"]["avgCostUsd"])
    body = json.dumps({"weights": {"quality": 0, "cost": 100, "latency": 0}})
    try:
        t0 = time.time()
        r = http.post(SITE + "/api/models/evaluate", headers=post_headers(analyst, body), content=body, timeout=120)
        ev = r.json()
        check(r.status_code == 200 and ev["selection"]["activeModel"] == cheapest["key"] and ev["deployment"],
              f"cost 100% routes live traffic to {cheapest['name']} via an AppConfig deployment ({time.time() - t0:.1f}s)", r.text[:300])
        for _ in range(12):  # other Lambda instances pick the change up within their 15 s AppConfig poll
            live = http.get(SITE + "/api/health").json().get("modelId")
            if live == cheapest["modelId"]:
                break
            time.sleep(3)
        check(live == cheapest["modelId"], "every API instance now reports the new model", live)
        if not args.no_analysis:
            events = []
            with http.stream("POST", SITE + "/api/claims/CLM-24830/analyze", headers=post_headers(analyst, "{}"), content="{}", timeout=300) as st:
                for line in st.iter_lines():
                    if line.strip():
                        events.append(json.loads(line))
            run2 = next((e["run"] for e in events if e["type"] == "run_completed"), None)
            check(run2 and run2["modelId"] == cheapest["modelId"] and run2["status"] == "PENDING_APPROVAL" and run2.get("costUsd", 0) > 0,
                  f"analysis ran on {cheapest['name']} without a redeploy (${(run2 or {}).get('costUsd', 0):.4f}, {(run2 or {}).get('durationMs', 0) / 1000:.0f}s)",
                  json.dumps({k: (run2 or {}).get(k) for k in ("modelId", "status", "error")}))
    finally:
        restore_selection(original)
    time.sleep(16)
    check(http.get(SITE + "/api/health").json().get("modelId") == next(m["modelId"] for m in models["catalog"]["models"] if m["key"] == original["activeModel"]),
          f"previous selection restored ({original['activeModel']})")

passed = sum(ok for ok, _ in results)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
