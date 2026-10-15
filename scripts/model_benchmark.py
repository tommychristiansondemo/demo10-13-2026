"""Build config/model-catalog.json (deployed to AWS AppConfig): live prices + a measured benchmark for each candidate LLM.

    .venv/bin/python scripts/model_benchmark.py                 # prices + benchmark all candidates (~10 min, ~$8 of Bedrock)
    .venv/bin/python scripts/model_benchmark.py --prices-only   # refresh prices, keep the last benchmark results
    .venv/bin/python scripts/model_benchmark.py --raw config/benchmark-raw.json   # re-aggregate an earlier run

Prices come from the AWS Price List API (us-east-1, on-demand; the geo tier for us.* cross-region profiles).
The benchmark runs the real agent (services/api/bench/benchmark.ts) against both deployed MCP servers on AgentCore
Runtime for all 8 synthetic claims and grades each run (completion, disposition, grounding, exact numbers, scenario).
Then `scripts/deploy.sh` (CDK) publishes the catalog as a new AppConfig version.
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
from datetime import datetime, timezone

import boto3

from outputs import ROOT, runtime_arns

CANDIDATES = ROOT / "config/model-candidates.json"
CATALOG = ROOT / "config/model-catalog.json"
RAW = ROOT / "config/benchmark-raw.json"

# Usage-type suffixes of the geo (us.*) tier; skips Global, batch, custom-model, latency-optimized and reserved rows.
SUFFIX = {
    "AmazonBedrockFoundationModels": {"input": "_InputTokenCount-Units", "output": "_OutputTokenCount-Units",
                                      "cacheRead": "_CacheReadInputTokenCount-Units", "cacheWrite": "_CacheWriteInputTokenCount-Units"},
    "AmazonBedrock": {"input": "-input-tokens", "output": "-output-tokens",
                      "cacheRead": "-cache-read-input-token-count", "cacheWrite": "-cache-write-input-token-count"},
}


def fetch_prices(cands: list[dict]) -> dict[str, dict]:
    pricing = boto3.client("pricing", region_name="us-east-1")
    rows: dict[str, list[tuple[str, float, str]]] = {}
    for service in {c["price"]["service"] for c in cands}:
        for page in pricing.get_paginator("get_products").paginate(
                ServiceCode=service, Filters=[{"Type": "TERM_MATCH", "Field": "regionCode", "Value": "us-east-1"}]):
            for item in page["PriceList"]:
                d = json.loads(item)
                a = d["product"]["attributes"]
                for term in d["terms"].get("OnDemand", {}).values():
                    for dim in term["priceDimensions"].values():
                        rows.setdefault(f"{service}|{a.get('model', '')}", []).append((a.get("usagetype", ""), float(dim["pricePerUnit"]["USD"]), dim["unit"]))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {}
    for c in cands:
        svc, model = c["price"]["service"], c["price"]["model"]
        found = {}
        for kind, suffix in SUFFIX[svc].items():
            for usagetype, usd, unit in rows.get(f"{svc}|{model}", []):
                if usagetype.endswith(suffix) and "custom" not in usagetype and "latency" not in usagetype:
                    found[kind] = round(usd * (1000 if unit.startswith("1K") else 1), 6)
        if "input" not in found or "output" not in found:
            sys.exit(f"No on-demand price found for {c['key']} ({svc} / {model})")
        p = {"inputPerMTok": found["input"], "outputPerMTok": found["output"]}
        if c["invocation"]["promptCache"]:
            p |= {k: found[v] for k, v in (("cacheReadPerMTok", "cacheRead"), ("cacheWritePerMTok", "cacheWrite")) if v in found}
        out[c["key"]] = p | {"source": f"AWS Price List API, {svc}, '{model}', us-east-1 on-demand", "fetchedAt": now}
        print(f"  {c['key']:20} in ${p['inputPerMTok']:.3f}  out ${p['outputPerMTok']:.3f} per 1M tokens")
    return out


def run_cost(p: dict, u: dict) -> float:
    return (u["inputTokens"] * p["inputPerMTok"] + u["outputTokens"] * p["outputPerMTok"]
            + u.get("cacheReadTokens", 0) * p.get("cacheReadPerMTok", p["inputPerMTok"])
            + u.get("cacheWriteTokens", 0) * p.get("cacheWritePerMTok", p["inputPerMTok"])) / 1e6


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices-only", action="store_true")
    ap.add_argument("--raw", help="aggregate an existing raw benchmark file instead of running")
    ap.add_argument("--models", help="comma-separated candidate keys to benchmark (default: all)")
    ap.add_argument("--parallel", default="4")
    a = ap.parse_args()

    cands = json.loads(CANDIDATES.read_text())["candidates"]
    print("Prices (AWS Price List API):")
    prices = fetch_prices(cands)

    raw_path = a.raw or str(RAW)
    if not a.prices_only and not a.raw:
        arns = runtime_arns()
        env = os.environ | {"CLAIMS_MCP_RUNTIME_ARN": arns["claims_policy"], "DAMAGE_MCP_RUNTIME_ARN": arns["damage_repair"],
                            "AWS_REGION": os.environ.get("AWS_REGION", "us-east-1"), "LOCAL_DEV": "1"}
        cmd = ["npx", "tsx", "services/api/bench/benchmark.ts", "--out", str(RAW), "--parallel", a.parallel]
        if a.models:
            cmd += ["--models", a.models]
        print(f"\nBenchmark: {' '.join(cmd)}")
        subprocess.run(cmd, cwd=ROOT, env=env, check=True)

    previous = {m["key"]: m["benchmark"] for m in json.loads(CATALOG.read_text())["models"]} if CATALOG.exists() else {}
    raw = json.loads(open(raw_path).read()) if os.path.exists(raw_path) else {"runs": []}
    by_model: dict[str, list[dict]] = {}
    for r in raw["runs"]:
        by_model.setdefault(r["model"], []).append(r)

    models = []
    print("\nResults (quality 0-100, mean seconds and USD per analysis):")
    for c in cands:
        runs = by_model.get(c["key"], [])
        if runs:
            bench = {
                "quality": round(statistics.mean(r["quality"] for r in runs), 1),
                "avgLatencySec": round(statistics.mean(r["durationMs"] for r in runs) / 1000, 1),
                "avgCostUsd": round(statistics.mean(run_cost(prices[c["key"]], r["usage"]) for r in runs), 5),
                "runs": len(runs),
                "completedRuns": sum(r["completed"] for r in runs),
                "correctDispositions": sum(r["dispositionCorrect"] for r in runs),
                "measuredAt": max(r.get("measuredAt", raw["measuredAt"]) for r in runs),
            }
        elif c["key"] in previous:
            bench = previous[c["key"]]
        else:
            bench = None
        flag = "*" if c["selected"] else " "
        if bench:
            print(f" {flag} {c['key']:20} quality {bench['quality']:5.1f}  {bench['avgLatencySec']:6.1f}s  ${bench['avgCostUsd']:.4f}  "
                  f"{bench['completedRuns']}/{bench['runs']} completed, {bench['correctDispositions']} correct dispositions")
        if c["selected"]:
            if not bench:
                sys.exit(f"{c['key']} is selected but has no benchmark results yet")
            entry = {k: c[k] for k in ("key", "name", "provider", "modelId", "foundationModel", "strengths", "tradeoffs", "invocation")}
            models.append(entry | {"pricing": prices[c["key"]], "benchmark": bench})

    catalog = {
        "version": int(datetime.now(timezone.utc).strftime("%Y%m%d%H%M")),
        "description": f"{len(models)} Amazon Bedrock LLMs the Claims Workbench agent can be routed to. Quality = mean score on an automatically "
                       "graded benchmark of the real task (8 synthetic claims; completion 25, correct disposition 35, grounding 20, exact "
                       "numbers 10, scenario must-have 10). Latency = mean seconds per full analysis (all model turns + MCP tool calls). "
                       "Cost = mean USD per analysis from measured token usage x AWS list prices.",
        "models": models,
    }
    CATALOG.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"\nWrote {CATALOG.relative_to(ROOT)} ({len(models)} models). Deploy with scripts/deploy.sh to publish it to AppConfig.")


if __name__ == "__main__":
    main()
