"""Preflight: confirm the configured Bedrock model answers a Converse call with tool use, and report newer Claude
inference profiles that are visible (so the instructor can decide whether to switch modelId in cdk.json)."""
import sys

import boto3

model_id = sys.argv[1]
region = boto3.session.Session().region_name or "us-east-1"
rt = boto3.client("bedrock-runtime", region_name=region)
ctl = boto3.client("bedrock", region_name=region)

tool = {"toolSpec": {"name": "ping", "description": "Return pong", "inputSchema": {"json": {"type": "object", "properties": {}}}}}


def probe(mid: str) -> str | None:
    try:
        # Same request shape as the app's agent loop: system cache point, tool use, temperature 0.
        r = rt.converse(modelId=mid, system=[{"text": "You are a test harness."}, {"cachePoint": {"type": "default"}}],
                        messages=[{"role": "user", "content": [{"text": "Call the ping tool."}]}],
                        toolConfig={"tools": [tool]}, inferenceConfig={"maxTokens": 64, "temperature": 0})
        return r["stopReason"]
    except Exception as e:  # noqa: BLE001
        return f"ERROR {type(e).__name__}: {str(e)[:140]}"


res = probe(model_id)
ok = res == "tool_use"
print(f"  {'✓' if ok else '✗'} configured model {model_id}: {res}")

try:
    profiles = ctl.list_inference_profiles(maxResults=200)["inferenceProfileSummaries"]
    newer = sorted(p["inferenceProfileId"] for p in profiles
                   if p["inferenceProfileId"].startswith("us.anthropic.claude") and p["inferenceProfileId"] != model_id
                   and any(t in p["inferenceProfileId"] for t in ("-5", "opus-4-7", "opus-4-8", "sonnet-4-7", "sonnet-4-8")))
    for mid in newer:
        print(f"  - newer candidate {mid}: {probe(mid)}")
except Exception as e:  # noqa: BLE001
    print(f"  ! could not list inference profiles: {e}")

sys.exit(0 if ok else 1)
