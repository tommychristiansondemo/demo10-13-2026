"""Claims & Policy MCP server.

Runs as its own Amazon Bedrock AgentCore Runtime (protocol MCP). AgentCore expects a
stateless Streamable HTTP server on 0.0.0.0:8000 at path /mcp.
"""
from __future__ import annotations

import functools
import json
import logging
import os
import sys
import time

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

import tools

SERVER_NAME = "claims-policy"
logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(message)s")
log = logging.getLogger(SERVER_NAME)

mcp = FastMCP(
    SERVER_NAME,
    instructions=(
        "Claims & Policy system of record for a fictional auto insurer (synthetic data). "
        "Use it for claim facts, policy coverage verdicts, shop repair estimates and claim status/history."
    ),
    host="0.0.0.0",
    port=int(os.environ.get("PORT", "8000")),
    stateless_http=True,
)
READ_ONLY = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)


def logged(fn):
    """Emit one structured log line per tool call (visible in the runtime's CloudWatch log group)."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        outcome = "ok"
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # surfaced to the client as an MCP tool error
            outcome = f"error: {exc}"
            raise
        finally:
            log.info(json.dumps({"log_type": "mcp_tool_call", "server": SERVER_NAME, "tool": fn.__name__,
                                 "args": kwargs, "outcome": outcome,
                                 "latency_ms": round((time.perf_counter() - start) * 1000, 1)}))
    return wrapper


@mcp.tool(annotations=READ_ONLY)
@logged
def list_claims(status: str | None = None) -> dict:
    """List open auto claims in the work queue. Optionally filter by a status substring (e.g. 'ESTIMATE')."""
    return tools.list_claims(status)


@mcp.tool(annotations=READ_ONLY)
@logged
def get_claim(claim_id: str) -> dict:
    """Get first notice of loss details for a claim: incident narrative, loss date/location, vehicle, driver,
    police report, injuries, third parties and repair facility. claim_id looks like 'CLM-24817'."""
    return tools.get_claim(claim_id)


@mcp.tool(annotations=READ_ONLY)
@logged
def get_policy_coverage(claim_id: str) -> dict:
    """Get the policy for a claim plus a computed coverage_check: first-party verdict (COVERED / NOT_COVERED),
    reasons, flags (e.g. early loss), deductible, rental reimbursement, medical payments and third-party liability."""
    return tools.get_policy_coverage(claim_id)


@mcp.tool(annotations=READ_ONLY)
@logged
def get_repair_estimate(claim_id: str) -> dict:
    """Get the repair shop's estimate for a claim: line items (line_id, op_code, labor, parts, line_total) and totals."""
    return tools.get_repair_estimate(claim_id)


@mcp.tool(annotations=READ_ONLY)
@logged
def get_claim_status(claim_id: str) -> dict:
    """Get claim status, reserves, payments, SLA checkpoints, activity history and prior losses on the same VIN."""
    return tools.get_claim_status(claim_id)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
