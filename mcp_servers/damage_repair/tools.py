"""Vehicle Damage & Repair business logic (simulated photo-based assessments).

Pure functions over the bundled synthetic dataset. Costs, ratios and reconciliation results
are computed here so the agent can quote them instead of calculating.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

_DATA = json.loads((Path(__file__).parent / "data" / "damage.json").read_text())
_VEHICLES = _DATA["vehicles"]
_RATES = _DATA["market_rates"]
_TL = _DATA["total_loss_rule"]

SOURCE = "damage-repair-mcp"
PARTS_PREFERENCES = ("oem", "aftermarket")
_HOURS_VARIANCE_TOLERANCE = 0.20


class NotFound(ValueError):
    pass


def _vehicle(claim_id: str) -> tuple[str, dict[str, Any]]:
    key = claim_id.strip().upper()
    v = _VEHICLES.get(key)
    if not v:
        raise NotFound(f"No damage assessment for claim_id '{claim_id}'.")
    return key, v


def _money(x: float) -> float:
    return round(x + 0.0, 2)


def _op_cost(op: dict[str, Any], prefer: str = "oem") -> dict[str, float]:
    labor = op["labor_hours"] * _RATES["labor"][op["labor_type"]]
    materials = op["labor_hours"] * _RATES["paint_materials_per_refinish_hour"] if op["labor_type"] == "refinish" else 0
    part = _part_price(op["part"], prefer)[0] if op.get("part") else 0
    return {"labor": _money(labor), "materials": _money(materials), "parts": _money(part),
            "pre_tax_total": _money(labor + materials + part),
            "tax": _money((part + materials) * _RATES["tax_rate"])}


def _part_price(part: dict[str, Any], prefer: str) -> tuple[float, str]:
    if prefer == "aftermarket" and part.get("aftermarket_price") is not None:
        return part["aftermarket_price"], "aftermarket"
    return part["oem_price"], "oem"


def get_damage_assessment(claim_id: str) -> dict[str, Any]:
    key, v = _vehicle(claim_id)
    return {"source": SOURCE, "claim_id": key, "assessment_model": _DATA["assessment_model"],
            "assessment": v["assessment"]}


def get_repair_operations(claim_id: str) -> dict[str, Any]:
    key, v = _vehicle(claim_id)
    ops, hours = [], {}
    for op in v["operations"]:
        cost = _op_cost(op)
        hours[op["labor_type"]] = round(hours.get(op["labor_type"], 0) + op["labor_hours"], 2)
        ops.append({k: op[k] for k in ("op_code", "description", "operation", "labor_type", "labor_hours")}
                   | {"has_part": bool(op.get("part")), "labor_amount": cost["labor"],
                      "materials_amount": cost["materials"], **({"required_reason": op["required_reason"]}
                                                                 if op.get("required_reason") else {})})
    return {"source": SOURCE, "claim_id": key, "basis": "Operations required by the damage assessment at market labor rates",
            "market_labor_rates": _RATES["labor"], "operations": ops, "labor_hours_by_type": hours,
            "total_labor_hours": round(sum(hours.values()), 2)}


def get_parts_estimate(claim_id: str, parts_preference: str = "oem") -> dict[str, Any]:
    prefer = parts_preference.lower().strip()
    if prefer not in PARTS_PREFERENCES:
        raise ValueError(f"parts_preference must be one of {PARTS_PREFERENCES}")
    key, v = _vehicle(claim_id)
    lines, total, lead = [], 0.0, 0
    for op in v["operations"]:
        part = op.get("part")
        if not part:
            continue
        price, used = _part_price(part, prefer)
        note = part.get("note")
        if prefer == "aftermarket" and used == "oem":
            note = "No aftermarket part available; OEM priced."
        lines.append({"op_code": op["op_code"], "part_number": part["part_number"], "description": part["description"],
                      "oem_price": part["oem_price"], "aftermarket_price": part.get("aftermarket_price"),
                      "priced_as": used, "price": price, "availability": part["availability"],
                      "lead_days": part["lead_days"], **({"note": note} if note else {})})
        total += price
        lead = max(lead, part["lead_days"])
    return {"source": SOURCE, "claim_id": key, "parts_preference": prefer, "parts": lines,
            "parts_total": _money(total), "max_lead_days": lead,
            "backordered": [p["op_code"] for p in lines if "backorder" in p["availability"]]}


def _projected(v: dict[str, Any], prefer: str) -> dict[str, float]:
    sums = {"labor": 0.0, "materials": 0.0, "parts": 0.0, "tax": 0.0}
    for op in v["operations"]:
        for k, val in _op_cost(op, prefer).items():
            if k in sums:
                sums[k] += val
    sums["total"] = sum(sums.values())
    return {k: _money(val) for k, val in sums.items()}


def get_severity_indicators(claim_id: str, parts_preference: str = "oem") -> dict[str, Any]:
    key, v = _vehicle(claim_id)
    a, val = v["assessment"], v["valuation"]
    cost = _projected(v, parts_preference.lower())
    ratio = cost["total"] / val["acv"]
    labor_hours = sum(op["labor_hours"] for op in v["operations"])
    lead = max([op["part"]["lead_days"] for op in v["operations"] if op.get("part")] or [0])
    repair_days = math.ceil(labor_hours / _RATES["labor_hours_per_shop_day"]) + lead

    flags = []
    if a["structural_damage"]:
        flags.append("STRUCTURAL_DAMAGE")
    if a["airbags_deployed"]:
        flags.append("AIRBAG_DEPLOYED")
    if not a["drivable"]:
        flags.append("NOT_DRIVABLE")
    if a["safety_systems_affected"]:
        flags.append("ADAS_OR_SRS_AFFECTED")
    if a["pre_existing_damage_indicators"] and any("inconsistent" in i or "age" in i for i in a["pre_existing_damage_indicators"]):
        flags.append("DAMAGE_CONSISTENCY_CONCERN")
    if a["hidden_damage_risk"] == "high":
        flags.append("SUPPLEMENT_LIKELY")
    if ratio >= _TL["threshold_ratio"]:
        flags.append("TOTAL_LOSS_THRESHOLD_MET")
    elif ratio >= _TL["threshold_ratio"] - 0.15:
        flags.append("APPROACHING_TOTAL_LOSS_THRESHOLD")

    return {"source": SOURCE, "claim_id": key, "overall_severity": a["overall_severity"],
            "severity_score": a["severity_score"], "assessment_confidence": a["confidence"],
            "projected_repair_cost": cost, "parts_preference": parts_preference.lower(),
            "actual_cash_value": val["acv"], "salvage_estimate": val["salvage_estimate"],
            "valuation_source": val["source"],
            "repair_cost_to_acv_ratio": round(ratio, 3), "total_loss_threshold_ratio": _TL["threshold_ratio"],
            "total_loss_indicated": ratio >= _TL["threshold_ratio"], "total_loss_rule": _TL["description"],
            "structural_damage": a["structural_damage"], "airbags_deployed": a["airbags_deployed"],
            "drivable": a["drivable"], "hidden_damage_risk": a["hidden_damage_risk"],
            "safety_systems_affected": a["safety_systems_affected"],
            "pre_existing_damage_indicators": a["pre_existing_damage_indicators"],
            "estimated_repair_days": repair_days, "max_parts_lead_days": lead, "indicator_flags": flags}


def reconcile_estimate(claim_id: str, estimate_lines: list[dict[str, Any]]) -> dict[str, Any]:
    """Compare shop estimate lines with the operations the damage assessment supports."""
    key, v = _vehicle(claim_id)
    required = {op["op_code"]: op for op in v["operations"]}
    misc = set(v.get("allowed_misc_op_codes", []))
    results, seen = [], set()
    unsupported_total = 0.0
    for line in estimate_lines:
        code = str(line.get("op_code", "")).strip().upper()
        amount = line.get("line_total")
        entry = {"line_id": line.get("line_id"), "op_code": code, "description": line.get("description"),
                 "line_total": amount}
        if code in required:
            seen.add(code)
            expected = required[code]["labor_hours"]
            hrs = line.get("labor_hours")
            if hrs is not None and expected and abs(hrs - expected) / expected > _HOURS_VARIANCE_TOLERANCE:
                entry |= {"status": "SUPPORTED_WITH_VARIANCE",
                          "detail": f"Labor {hrs} h vs {expected} h supported by the assessment."}
            else:
                entry |= {"status": "SUPPORTED", "detail": "Consistent with assessed damage."}
        elif code in misc:
            entry |= {"status": "ADMINISTRATIVE", "detail": "Standard miscellaneous charge; accepted."}
        else:
            entry |= {"status": "NOT_SUPPORTED_BY_DAMAGE",
                      "detail": "No damage to this part/area in the assessment "
                                f"(areas without new damage: {', '.join(v['assessment']['areas_without_new_damage'])})."}
            unsupported_total += amount or 0
        results.append(entry)

    missing, missing_total = [], 0.0
    for code, op in required.items():
        if code not in seen:
            cost = _op_cost(op)
            missing.append({"op_code": code, "description": op["description"], "labor_type": op["labor_type"],
                            "labor_hours": op["labor_hours"], "estimated_pre_tax_cost": cost["pre_tax_total"],
                            **({"required_reason": op["required_reason"]} if op.get("required_reason") else {})})
            missing_total += cost["pre_tax_total"]

    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"source": SOURCE, "claim_id": key, "lines_reviewed": len(results), "status_counts": counts,
            "line_results": results, "missing_required_operations": missing,
            "unsupported_amount_pre_tax": _money(unsupported_total),
            "missing_operations_amount_pre_tax": _money(missing_total),
            "net_adjustment_pre_tax": _money(missing_total - unsupported_total),
            "note": "Missing operations priced at market rates; unsupported amounts use the shop's line_total."}
