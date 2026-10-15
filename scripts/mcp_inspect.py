"""Talk to the deployed MCP servers directly from your laptop (your IAM credentials, SigV4) - the classroom
"prove it" step: two independent AgentCore runtimes, each enumerating its own tools.

    .venv/bin/python scripts/mcp_inspect.py                      # list both servers' tools
    .venv/bin/python scripts/mcp_inspect.py --call claims_policy get_claim '{"claim_id":"CLM-24817"}'
    .venv/bin/python scripts/mcp_inspect.py --runtimes           # show the AgentCore runtime resources
"""
import argparse
import asyncio
import json
import urllib.parse
import uuid

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from outputs import runtime_arns


class SigV4HttpxAuth(httpx.Auth):
    requires_request_body = True

    def __init__(self, region: str):
        self.region = region
        self.creds = boto3.Session().get_credentials()

    def auth_flow(self, request: httpx.Request):
        headers = {k: v for k, v in request.headers.items() if k.lower() not in ("connection", "accept-encoding", "user-agent")}
        aws = AWSRequest(method=request.method, url=str(request.url), data=request.content, headers=headers)
        SigV4Auth(self.creds.get_frozen_credentials(), "bedrock-agentcore", self.region).add_auth(aws)
        request.headers.update(dict(aws.headers))
        yield request


def endpoint(region: str, arn: str) -> str:
    return f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{urllib.parse.quote(arn, safe='')}/invocations?qualifier=DEFAULT"


async def with_session(region: str, arn: str, fn):
    headers = {"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": f"inspect-{uuid.uuid4()}-{uuid.uuid4().hex[:6]}"}
    async with streamablehttp_client(endpoint(region, arn), headers=headers, auth=SigV4HttpxAuth(region), timeout=60) as (r, w, _):
        async with ClientSession(r, w) as s:
            init = await s.initialize()
            return init, await fn(s)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--call", nargs=3, metavar=("SERVER", "TOOL", "ARGS_JSON"))
    ap.add_argument("--runtimes", action="store_true")
    a = ap.parse_args()
    region = boto3.Session().region_name or "us-east-1"
    arns = runtime_arns()

    if a.runtimes:
        ctl = boto3.client("bedrock-agentcore-control", region_name=region)
        for sid, arn in arns.items():
            rt = ctl.get_agent_runtime(agentRuntimeId=arn.split("/")[-1])
            print(json.dumps({k: rt.get(k) for k in ("agentRuntimeName", "agentRuntimeId", "agentRuntimeVersion", "status",
                                                      "protocolConfiguration", "roleArn", "lastUpdatedAt")}, default=str, indent=2))
        return

    if a.call:
        server, tool, args = a.call
        _, res = await with_session(region, arns[server], lambda s: s.call_tool(tool, json.loads(args)))
        print(("ERROR: " if res.isError else "") + "\n".join(c.text for c in res.content if c.type == "text"))
        return

    for sid, arn in arns.items():
        init, tools = await with_session(region, arn, lambda s: s.list_tools())
        print(f"\n== {sid}  ({init.serverInfo.name}, MCP {init.protocolVersion})\n   {arn}")
        for t in tools.tools:
            print(f"   - {t.name}: {(t.description or '').splitlines()[0][:100]}")


if __name__ == "__main__":
    asyncio.run(main())
