"""In-class credential check: shows WHERE the AWS credentials on this workstation came from, WHAT identity they map to,
and HOW LONG they last, without ever printing a secret. Run it after signing in, before anything is deployed.

    .venv/bin/python scripts/credentials_check.py

Talking points it surfaces:
  * temporary (ASIA..., session token, expiry) vs long-lived (AKIA..., never expires) keys
  * the credential source (env vars, ~/.aws/credentials, `aws login`, IAM Identity Center/SSO, assumed role)
  * the identity must be the expected account (cdk.json -> workbench.account) before anything is created
  * the Node.js SDK (used by the CDK CLI) resolves the same identity as the Python SDK and AWS CLI
  * none of these credentials are given to the deployed app: it runs on its own IAM roles in AWS
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import BotoCoreError, ClientError

ROOT = Path(__file__).resolve().parents[1]
G, Y, R, B, X = "\033[32m", "\033[33m", "\033[31m", "\033[1m", "\033[0m"
ok = lambda s: print(f"  {G}✓{X} {s}")  # noqa: E731
warn = lambda s: print(f"  {Y}!{X} {s}")  # noqa: E731
bad = lambda s: print(f"  {R}✗{X} {s}")  # noqa: E731
SOURCES = {
    "env": "environment variables (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)",
    "shared-credentials-file": "~/.aws/credentials file",
    "config-file": "~/.aws/config file (static keys)",
    "login": "`aws login` (console sign-in, short-lived, auto-refreshing)",
    "sso": "IAM Identity Center (SSO) session",
    "assume-role": "assumed IAM role (profile role_arn)",
    "assume-role-with-web-identity": "web identity (OIDC) role",
    "custom-process": "credential_process helper",
    "iam-role": "EC2 instance profile",
    "container-role": "container task role",
}
cfg = json.loads((ROOT / "cdk.json").read_text())["context"]["workbench"]
for var in ("AWS_REGION", "AWS_DEFAULT_REGION"):
    os.environ.setdefault(var, cfg["region"])
failed = False

print(f"{B}1. Where do the credentials come from?{X}")
profile = os.environ.get("AWS_PROFILE", "default")
print(f"  profile: {profile}   region: {os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or boto3.session.Session().region_name or '(not set)'}")
session = boto3.session.Session()
creds = session.get_credentials()
if creds is None:
    bad("no credentials found. Sign in with one of:")
    print("      aws login                      # browser sign-in, temporary credentials (recommended)")
    print("      aws configure sso              # IAM Identity Center")
    print("      aws configure                  # IAM user access key (long-lived; least preferred)")
    sys.exit(1)
frozen = creds.get_frozen_credentials()
ok(f"source: {SOURCES.get(creds.method, creds.method)}")
key = frozen.access_key
kind = "temporary (STS)" if key.startswith("ASIA") or frozen.token else "LONG-LIVED IAM user key"
print(f"  access key id: {key[:4]}…{key[-4:]}   type: {kind}   secret: (never printed)")
if frozen.token:
    ok("session token present: these credentials expire on their own")
else:
    warn("long-lived key: works until someone deletes it. Rotate or delete it after class")
expiry = getattr(creds, "_expiry_time", None)
if expiry:
    mins = int((expiry - datetime.now(timezone.utc)).total_seconds() // 60)
    print(f"  expires: {expiry.isoformat(timespec='minutes')} (~{mins} min; refreshable sources renew automatically)")
if os.environ.get("AWS_ACCESS_KEY_ID") and creds.method != "env":
    warn("AWS_ACCESS_KEY_ID is set in the environment but another source won (check AWS_PROFILE)")

print(f"\n{B}2. Who am I?{X}")
try:
    ident = session.client("sts").get_caller_identity()
except (ClientError, BotoCoreError) as e:
    bad(f"STS rejected the credentials: {e}")
    sys.exit(1)
ok(f"arn: {ident['Arn']}")
expected = cfg.get("account")
if expected and ident["Account"] != expected:
    bad(f"account {ident['Account']} is NOT the expected account {expected} (cdk.json workbench.account). Stop here.")
    failed = True
else:
    ok(f"account {ident['Account']} matches cdk.json workbench.account")
if ":root" in ident["Arn"]:
    warn("these are ROOT user credentials: use an IAM user/role or `aws login` instead")

print(f"\n{B}3. Do the CDK CLI (Node.js SDK) and AWS CLI see the same identity?{X}")
node = r"""
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
defaultProvider()().then((c) => console.log('KEY ' + c.accessKeyId.slice(0, 4) + '…' + c.accessKeyId.slice(-4)),
                         (e) => { console.log('ERROR ' + e.message); process.exit(1); });
"""
try:
    out = subprocess.run(["node", "-e", node], cwd=ROOT, capture_output=True, text=True, timeout=60).stdout.strip()
    if out.startswith("KEY") and out[4:] == f"{key[:4]}…{key[-4:]}":
        ok("Node.js SDK resolves the same access key")
    else:
        bad(f"Node.js SDK resolved something else: {out or '(nothing)'}")
        failed = True
except Exception as e:  # noqa: BLE001
    warn(f"could not run the Node.js check: {e}")
cli = subprocess.run(["aws", "sts", "get-caller-identity", "--query", "Arn", "--output", "text"], capture_output=True, text=True)
if cli.stdout.strip() == ident["Arn"]:
    ok("AWS CLI resolves the same identity")
else:
    bad(f"AWS CLI: {(cli.stdout or cli.stderr).strip()[:160]}")
    failed = True

print(f"\n{B}4. Does the deployed app keep using these credentials?{X}")
print("  No. They are used only to create resources from this workstation. At run time the app uses IAM roles that")
print("  live in AWS (API Lambda role, one execution role per MCP runtime), and people sign in through Cognito.")
print("  After deployment you can sign out (`aws logout`), delete the key, or shut this machine down.")

sys.exit(1 if failed else 0)
