"""Step 0 (run before anything else): activate every Anthropic Claude 5.x model in this account/region, then prove each
one with a live Converse call. Listing a model is not proof of access, so a model counts as "working" only after a
real call to it succeeds.

    .venv/bin/python scripts/enable_models.py            # activate + verify
    .venv/bin/python scripts/enable_models.py --dry-run  # report only, change nothing

What "activate" means on Bedrock (all account-level, no subscription fee; billing is per token):
  1. Anthropic use-case form: submitted once per account. If it is missing, the script stops and says so (the form
     asks for company details, which only the account owner should supply).
  2. Model agreement (Marketplace offer): created per model if it does not exist yet.
  3. Verification: one tiny Converse call per model via its cross-region inference profile.
Needs bedrock:* model-access actions plus aws-marketplace:Subscribe / ViewSubscriptions on the calling identity.
"""
import argparse
import re
import sys
import time

import boto3
from botocore.exceptions import ClientError

ap = argparse.ArgumentParser()
ap.add_argument("--dry-run", action="store_true")
ap.add_argument("--pattern", default=r"claude-[a-z]+-5(?![0-9])", help="regex for model ids to activate")
a = ap.parse_args()

region = boto3.session.Session().region_name or "us-east-1"
ctl = boto3.client("bedrock", region_name=region)
rt = boto3.client("bedrock-runtime", region_name=region)
G, Y, R, B, X = "\033[32m", "\033[33m", "\033[31m", "\033[1m", "\033[0m"
err = lambda e: f"{e.response['Error']['Code']}: {e.response['Error']['Message'][:160]}"  # noqa: E731

print(f"{B}Region {region} · account {boto3.client('sts').get_caller_identity()['Account']}{X}")

# --- 1. Use-case form (account-wide, required once for Anthropic models)
try:
    ctl.get_use_case_for_model_access()
    print(f"  {G}✓{X} Anthropic use-case form is on file for this account")
except ClientError as e:
    print(f"  {R}✗{X} use-case form not found ({err(e)})")
    print("    Submit it once in the Bedrock console (Model catalog -> any Anthropic model -> request access), then re-run.")
    sys.exit(1)

# --- 2. Discover Claude 5.x models and their inference profiles
models = [m for m in ctl.list_foundation_models(byProvider="Anthropic")["modelSummaries"] if re.search(a.pattern, m["modelId"])]
if not models:
    print(f"  {Y}!{X} no Anthropic models matching /{a.pattern}/ are offered in {region}")
    sys.exit(1)
profiles = ctl.list_inference_profiles(maxResults=200, typeEquals="SYSTEM_DEFINED")["inferenceProfileSummaries"]


def profile_for(model_id: str) -> str:
    """Prefer the geo (us.) profile, then global., else the bare model id."""
    ids = [p["inferenceProfileId"] for p in profiles if any(m["modelArn"].endswith("/" + model_id) for m in p["models"])]
    for prefix in ("us.", "global."):
        for i in ids:
            if i.startswith(prefix):
                return i
    return ids[0] if ids else model_id


def availability(model_id: str) -> dict:
    return ctl.get_foundation_model_availability(modelId=model_id)


print(f"\n{B}Activating {len(models)} Claude 5.x model(s){X}")
for m in models:
    mid = m["modelId"]
    try:
        av = availability(mid)
    except ClientError as e:
        print(f"  {R}✗{X} {mid}: availability check failed ({err(e)})")
        continue
    st = av["agreementAvailability"]["status"]
    line = f"agreement={st} authorization={av['authorizationStatus']} entitlement={av['entitlementAvailability']} region={av['regionAvailability']}"
    if st in ("AVAILABLE", "PENDING"):
        print(f"  {G}✓{X} {mid}: {line}")
        continue
    if a.dry_run:
        print(f"  {Y}!{X} {mid}: {line} (dry run: would create agreement)")
        continue
    try:
        offers = ctl.list_foundation_model_agreement_offers(modelId=mid, offerType="PUBLIC")["offers"]
        if not offers:
            print(f"  {R}✗{X} {mid}: no public agreement offer available ({line})")
            continue
        ctl.create_foundation_model_agreement(modelId=mid, offerToken=offers[0]["offerToken"])
        print(f"  {G}✓{X} {mid}: agreement requested (was {st})")
    except ClientError as e:
        print(f"  {R}✗{X} {mid}: could not create agreement ({err(e)})")

if a.dry_run:
    sys.exit(0)

# --- 3. Wait for agreements to settle, then prove each model with a real call
print(f"\n{B}Waiting for agreements (up to 5 min){X}")
deadline = time.time() + 300
pending = {m["modelId"] for m in models}
while pending and time.time() < deadline:
    for mid in sorted(pending):
        try:
            if availability(mid)["agreementAvailability"]["status"] != "PENDING":
                pending.discard(mid)
        except ClientError:
            pending.discard(mid)
    if pending:
        time.sleep(10)
for mid in sorted(pending):
    print(f"  {Y}!{X} {mid}: still PENDING after 5 min (verification below may fail; re-run later)")

print(f"\n{B}Live Converse check{X}")
working = []
for m in models:
    target = profile_for(m["modelId"])
    try:
        r = rt.converse(modelId=target, messages=[{"role": "user", "content": [{"text": "Reply with the word ready."}]}],
                        inferenceConfig={"maxTokens": 16})
        working.append(target)
        print(f"  {G}✓{X} {target}: {r['output']['message']['content'][0]['text'].strip()[:30]!r}")
    except ClientError as e:
        print(f"  {R}✗{X} {target}: {err(e)}")

print(f"\n{len(working)}/{len(models)} Claude 5.x models answer live calls.")
if working:
    print("Working ids (any of these can go into cdk.json -> workbench.modelId):")
    for w in working:
        print(f"  {w}")
sys.exit(0 if len(working) == len(models) else 2)
