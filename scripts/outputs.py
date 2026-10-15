"""Read CloudFormation stack outputs (shared by the Python scripts)."""
import functools
import json
import os
import subprocess
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parents[1]
CDK = json.loads((ROOT / "cdk.json").read_text())["context"]["workbench"]
# Scripts work standalone even when the AWS profile has no region configured.
os.environ.setdefault("AWS_DEFAULT_REGION", CDK["region"])
os.environ.setdefault("AWS_REGION", CDK["region"])


@functools.cache
def _outputs(stack: str) -> dict[str, str]:
    cf = boto3.client("cloudformation")
    st = cf.describe_stacks(StackName=stack)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in st.get("Outputs", [])}


def output(stack: str, key_prefix: str) -> str:
    for k, v in _outputs(stack).items():
        if k.startswith(key_prefix):
            return v
    raise KeyError(f"{stack} has no output starting with {key_prefix}")


def runtime_arns() -> dict[str, str]:
    return {"claims_policy": output("ClaimsWb-McpRuntimes", "claimspolicymcpArn"),
            "damage_repair": output("ClaimsWb-McpRuntimes", "damagerepairmcpArn")}


def site_url() -> str:
    return f"https://{CDK['siteHostname']}"
