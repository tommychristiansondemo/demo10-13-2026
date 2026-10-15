"""Starts both MCP servers locally and talks to them over Streamable HTTP with the official MCP client,
exactly as the orchestrator does (minus SigV4)."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

ROOT = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def servers():
    procs, urls = [], {}
    for name in ("claims_policy", "damage_repair"):
        port = _free_port()
        p = subprocess.Popen([sys.executable, "server.py"], cwd=ROOT / name, env={**os.environ, "PORT": str(port)},
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs.append(p)
        urls[name] = f"http://127.0.0.1:{port}/mcp"
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
    yield urls
    for p in procs:
        p.terminate()


async def _session_call(url, fn):
    async with streamablehttp_client(url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await fn(session)


def test_tool_lists(servers):
    async def names(s):
        return sorted(t.name for t in (await s.list_tools()).tools)
    assert asyncio.run(_session_call(servers["claims_policy"], names)) == [
        "get_claim", "get_claim_status", "get_policy_coverage", "get_repair_estimate", "list_claims"]
    assert asyncio.run(_session_call(servers["damage_repair"], names)) == [
        "get_damage_assessment", "get_parts_estimate", "get_repair_operations", "get_severity_indicators", "reconcile_estimate"]


def test_cross_server_reconcile(servers):
    async def estimate(s):
        r = await s.call_tool("get_repair_estimate", {"claim_id": "CLM-24817"})
        return json.loads(r.content[0].text)
    est = asyncio.run(_session_call(servers["claims_policy"], estimate))["estimate"]
    lines = [{k: line.get(k) for k in ("line_id", "op_code", "description", "labor_hours", "line_total")} for line in est["lines"]]

    async def reconcile(s):
        r = await s.call_tool("reconcile_estimate", {"claim_id": "CLM-24817", "estimate_lines": lines})
        assert not r.isError
        return json.loads(r.content[0].text)
    out = asyncio.run(_session_call(servers["damage_repair"], reconcile))
    assert {m["op_code"] for m in out["missing_required_operations"]} == {"RDR-CAL", "SCAN-PP"}


def test_unknown_claim_is_tool_error(servers):
    async def bad(s):
        return await s.call_tool("get_claim", {"claim_id": "CLM-00000"})
    r = asyncio.run(_session_call(servers["claims_policy"], bad))
    assert r.isError and "Unknown claim_id" in r.content[0].text
