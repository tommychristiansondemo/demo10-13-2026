"""Vehicle Damage & Repair MCP server.

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
from typing import Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

import tools

SERVER_NAME = "damage-repair"
logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(message)s")
log = logging.getLogger(SERVER_NAME)

mcp = FastMCP(
    SERVER_NAME,
    instructions=(
        "Vehicle Damage & Repair service (simulated photo-based assessments, synthetic data). "
        "Use it for damage assessments, required repair operations, parts pricing, severity / total-loss "
        "indicators and to reconcile a shop estimate against the assessed damage."
    ),
    host="0.0.0.0",
    port=int(os.environ.get("PORT", "8000")),
    stateless_http=True,
)
READ_ONLY = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)
PartsPreference = Literal["oem", "aftermarket"]


class EstimateLine(BaseModel):
    line_id: str = Field(description="Shop estimate line id, e.g. 'L3'")
    op_code: str = Field(description="Standard operation code from the estimate, e.g. 'RBC-RPL'")
    description: str | None = None
    labor_hours: float | None = None
    line_total: float | None = Field(default=None, description="Pre-tax line total from the shop estimate")


def logged(fn):
    """Emit one structured log line per tool call (visible in the runtime's CloudWatch log group)."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        outcome = "ok"
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            outcome = f"error: {exc}"
            raise
        finally:
            safe_args = {k: (f"<{len(v)} lines>" if isinstance(v, list) else v) for k, v in kwargs.items()}
            log.info(json.dumps({"log_type": "mcp_tool_call", "server": SERVER_NAME, "tool": fn.__name__,
                                 "args": safe_args, "outcome": outcome,
                                 "latency_ms": round((time.perf_counter() - start) * 1000, 1)}))
    return wrapper


@mcp.tool(annotations=READ_ONLY)
@logged
def get_damage_assessment(claim_id: str) -> dict:
    """Get the simulated photo-based damage assessment for a claim: damaged parts with severity and confidence,
    structural damage, airbag deployment, drivability, affected ADAS/SRS systems and pre-existing damage indicators."""
    return tools.get_damage_assessment(claim_id)


@mcp.tool(annotations=READ_ONLY)
@logged
def get_repair_operations(claim_id: str) -> dict:
    """Get the repair operations the assessed damage requires (op_code, operation, labor type and hours) at market rates,
    including required calibrations and scans."""
    return tools.get_repair_operations(claim_id)


@mcp.tool(annotations=READ_ONLY)
@logged
def get_parts_estimate(claim_id: str, parts_preference: PartsPreference = "oem") -> dict:
    """Price the parts the assessed damage requires, as OEM or aftermarket, with availability and lead times."""
    return tools.get_parts_estimate(claim_id, parts_preference)


@mcp.tool(annotations=READ_ONLY)
@logged
def get_severity_indicators(claim_id: str, parts_preference: PartsPreference = "oem") -> dict:
    """Get severity and total-loss indicators: projected repair cost, actual cash value, repair-cost-to-ACV ratio vs the
    total-loss threshold, estimated repair days and indicator flags (structural, airbag, ADAS, supplement risk...)."""
    return tools.get_severity_indicators(claim_id, parts_preference)


@mcp.tool(annotations=READ_ONLY)
@logged
def reconcile_estimate(claim_id: str, estimate_lines: list[EstimateLine]) -> dict:
    """Reconcile a shop estimate against the damage assessment. Pass every line from the Claims & Policy
    get_repair_estimate result (line_id, op_code, description, labor_hours, line_total). Returns per-line status
    (SUPPORTED / SUPPORTED_WITH_VARIANCE / NOT_SUPPORTED_BY_DAMAGE / ADMINISTRATIVE), required operations missing
    from the estimate, and the net pre-tax adjustment."""
    return tools.reconcile_estimate(claim_id, [line.model_dump() for line in estimate_lines])


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
