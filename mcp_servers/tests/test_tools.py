"""Unit tests for the MCP servers' business logic (no network)."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, folder: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / folder / "tools.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


claims = _load("claims_tools", "claims_policy")
damage = _load("damage_tools", "damage_repair")
ALL_IDS = [c["claim_id"] for c in claims.list_claims()["claims"]]


def test_every_claim_has_policy_estimate_status_and_assessment():
    assert len(ALL_IDS) == 8
    for cid in ALL_IDS:
        assert claims.get_policy_coverage(cid)["policy"]
        assert claims.get_repair_estimate(cid)["estimate"]
        assert claims.get_claim_status(cid)["events"]
        assert damage.get_damage_assessment(cid)["assessment"]
        assert damage.get_severity_indicators(cid)["actual_cash_value"] > 0


def test_unknown_claim_raises():
    with pytest.raises(ValueError):
        claims.get_claim("CLM-00000")
    with pytest.raises(ValueError):
        damage.get_damage_assessment("CLM-00000")


def test_demo_claim_reconciliation():
    est = claims.get_repair_estimate("CLM-24817")["estimate"]
    lines = [{k: line.get(k) for k in ("line_id", "op_code", "description", "labor_hours", "line_total")} for line in est["lines"]]
    r = damage.reconcile_estimate("CLM-24817", lines)
    unsupported = {x["op_code"] for x in r["line_results"] if x["status"] == "NOT_SUPPORTED_BY_DAMAGE"}
    missing = {x["op_code"] for x in r["missing_required_operations"]}
    assert unsupported == {"FBC-RFN", "HOD-RPR"}
    assert missing == {"RDR-CAL", "SCAN-PP"}
    assert r["status_counts"]["ADMINISTRATIVE"] == 1
    assert r["unsupported_amount_pre_tax"] == pytest.approx(2.4 * 62 + 2.4 * 38 + 2.0 * 62)
    assert r["missing_operations_amount_pre_tax"] == pytest.approx(3.0 * 125)


def test_demo_claim_coverage_and_severity():
    cov = claims.get_policy_coverage("CLM-24817")["coverage_check"]
    assert cov["first_party_verdict"] == "COVERED"
    assert cov["deductible"] == 500 and cov["deductible_waived_if_subrogation_recovered"]
    assert cov["rental_reimbursement"]["daily_limit"] == 40
    sev = damage.get_severity_indicators("CLM-24817")
    assert not sev["total_loss_indicated"]
    assert "ADAS_OR_SRS_AFFECTED" in sev["indicator_flags"]


@pytest.mark.parametrize("cid,verdict,reason_fragment", [
    ("CLM-24841", "NOT_COVERED", "excluded driver"),
    ("CLM-24858", "NOT_COVERED", "no collision coverage"),
    ("CLM-24830", "COVERED", None),
])
def test_coverage_verdicts(cid, verdict, reason_fragment):
    cov = claims.get_policy_coverage(cid)["coverage_check"]
    assert cov["first_party_verdict"] == verdict
    if reason_fragment:
        assert any(reason_fragment in r for r in cov["reasons_not_covered"])


def test_glass_uses_full_glass_zero_deductible():
    cov = claims.get_policy_coverage("CLM-24830")["coverage_check"]
    assert cov["applicable_coverage"] == "full_glass" and cov["deductible"] == 0


def test_liability_only_still_covers_third_party():
    cov = claims.get_policy_coverage("CLM-24858")["coverage_check"]
    assert cov["third_party_liability"]["verdict"] == "COVERED"


def test_excluded_driver_liability_needs_review():
    cov = claims.get_policy_coverage("CLM-24841")["coverage_check"]
    assert cov["third_party_liability"]["verdict"] == "COVERAGE_REVIEW"


def test_total_loss_candidate():
    sev = damage.get_severity_indicators("CLM-24822")
    assert sev["total_loss_indicated"] and sev["repair_cost_to_acv_ratio"] > 1.0
    assert {"AIRBAG_DEPLOYED", "STRUCTURAL_DAMAGE", "TOTAL_LOSS_THRESHOLD_MET"} <= set(sev["indicator_flags"])


def test_siu_indicators():
    cov = claims.get_policy_coverage("CLM-24835")["coverage_check"]
    assert any(f.startswith("EARLY_LOSS") for f in cov["flags"])
    assert claims.get_claim_status("CLM-24835")["prior_losses_found"] == 1
    assert "DAMAGE_CONSISTENCY_CONCERN" in damage.get_severity_indicators("CLM-24835")["indicator_flags"]


def test_aftermarket_falls_back_to_oem_when_unavailable():
    p = damage.get_parts_estimate("CLM-24822", "aftermarket")
    srs = next(x for x in p["parts"] if x["op_code"] == "SRS-RPL")
    assert srs["priced_as"] == "oem"
    assert p["backordered"] == ["FRL-RPL"]


def test_only_demo_claim_lines_fully_reconcile_for_clean_claims():
    for cid in ("CLM-24830", "CLM-24852"):
        est = claims.get_repair_estimate(cid)["estimate"]
        r = damage.reconcile_estimate(cid, est["lines"])
        assert r["status_counts"] == {"SUPPORTED": len(est["lines"])}
        assert r["missing_required_operations"] == []
