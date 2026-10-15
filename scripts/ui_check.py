"""Headless browser walkthrough of the DEPLOYED site: Cognito managed login -> queue -> demo claim -> live AI analysis
-> citation click -> supervisor approval -> MCP servers page -> phone layout. Screenshots go to ./test-results/.

    .venv/bin/python scripts/ui_check.py [--claim CLM-24817] [--headed]
"""
import argparse
import json
import sys
import time
from pathlib import Path

import boto3
from playwright.sync_api import expect, sync_playwright

from outputs import site_url

ap = argparse.ArgumentParser()
ap.add_argument("--claim", default="CLM-24817")
ap.add_argument("--headed", action="store_true")
a = ap.parse_args()
OUT = Path(__file__).resolve().parents[1] / "test-results"
OUT.mkdir(exist_ok=True)
SITE = site_url()
sm = boto3.client("secretsmanager")
pw = lambda u: json.loads(sm.get_secret_value(SecretId=f"claims-workbench/demo-users/{u}")["SecretString"])["password"]  # noqa: E731
results = []
STAMP = str(int(time.time()))
STUDENTS = {"supervisor": f"ui-student-sup-{STAMP}", "analyst": f"ui-student-an-{STAMP}"}


def check(label, fn):
    try:
        fn()
        results.append(True)
        print(f"  ✓ {label}")
    except Exception as e:  # noqa: BLE001
        results.append(False)
        print(f"  ✗ {label}: {str(e).splitlines()[0][:200]}")


def register(page, user_type):
    """Student self-registration on the in-app Create account form: 6-char password, no email, chosen user type."""
    uname = STUDENTS[user_type]
    page.goto(SITE + "/")
    page.get_by_role("button", name="Create an account").click()
    page.locator("input[name=username]").fill(uname)
    page.locator("input[name=password]").fill("aaaaaa")
    page.locator(f"input[name=userType][value={user_type}]").check()
    page.get_by_role("button", name="Create account and sign in").click()
    expect(page.locator(".user-name")).to_have_text(uname, timeout=20_000)
    expect(page.locator(".user .role")).to_have_text("Supervisor" if user_type == "supervisor" else "Analyst")


def sign_in(page, user):
    page.goto(SITE + "/")
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url("**/login**", timeout=20_000)
    page.locator("input[name=username]").fill(user)
    if page.locator("input[name=password]").count() == 0 or not page.locator("input[name=password]").is_visible():
        page.get_by_role("button", name="Next").click()  # managed login v2 may ask for the username first
    page.locator("input[name=password]").fill(pw(user))
    page.locator("button[type=submit]").first.click()
    page.wait_for_url(SITE + "/**", timeout=20_000)
    expect(page.locator(".user-name")).to_have_text(user, timeout=20_000)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=not a.headed)
    errors = []
    sup = browser.new_context(viewport={"width": 1440, "height": 1000}).new_page()
    sup.on("pageerror", lambda e: errors.append(str(e)))

    check("supervisor signs in through Cognito managed login", lambda: sign_in(sup, "claims.supervisor"))
    check("work queue lists 8 claims", lambda: expect(sup.locator("table.queue tbody tr")).to_have_count(8, timeout=30_000))
    sup.screenshot(path=OUT / "1_queue.png", full_page=True)

    def open_claim():
        sup.get_by_text(a.claim, exact=True).click()
        expect(sup.locator(".via")).to_have_count(6, timeout=30_000)
    check(f"{a.claim} claim file assembled from 6 MCP calls", open_claim)

    def analyze():
        sup.get_by_role("button", name="Run AI analysis").or_(sup.get_by_role("button", name="Re-run analysis")).click()
        expect(sup.locator(".trace-tool").first).to_be_visible(timeout=60_000)
        expect(sup.locator(".rec-disposition")).to_be_visible(timeout=280_000)
        expect(sup.locator(".approval")).to_contain_text("Pending supervisor approval", timeout=30_000)
    check("live analysis streams tool calls and a recommendation", analyze)
    check("trace shows both MCP servers", lambda: (expect(sup.locator(".trace-tool .server-chip.claims_policy").first).to_be_visible(),
                                                   expect(sup.locator(".trace-tool .server-chip.damage_repair").first).to_be_visible()))
    check("grounding: all citations valid", lambda: expect(sup.locator(".grounding")).to_contain_text("All citations valid"))

    def cite():
        sup.locator(".rec .cite").first.click()
        expect(sup.locator(".trace-tool.focused pre")).to_be_visible()
    check("citation chip opens the evidence", cite)
    sup.screenshot(path=OUT / "2_analysis.png", full_page=True)

    student = browser.new_context(viewport={"width": 1440, "height": 1000}).new_page()
    student.on("pageerror", lambda e: errors.append(str(e)))
    check("student registers as a SUPERVISOR (6-char password, no email)", lambda: register(student, "supervisor"))

    def approve():
        student.goto(f"{SITE}/claims/{a.claim}")
        student.get_by_role("button", name="Approve plan").click()
        expect(student.locator(".approval.decided")).to_contain_text("APPROVED", timeout=15_000)
    check("self-registered supervisor approves the plan", approve)
    student.screenshot(path=OUT / "3a_student_supervisor.png", full_page=True)

    def mcp_page():
        sup.get_by_role("link", name="MCP servers").click()
        expect(sup.locator(".tool-list li")).to_have_count(10, timeout=30_000)
        expect(sup.locator(".server-card code.wrap").first).to_contain_text("arn:aws:bedrock-agentcore")
    check("MCP servers page enumerates 5 + 5 tools from the runtimes", mcp_page)
    sup.screenshot(path=OUT / "3_mcp.png", full_page=True)

    def models_page():
        sup.get_by_role("link", name="Model routing").click()
        expect(sup.locator("table.ranking tbody tr")).to_have_count(8, timeout=30_000)
        expect(sup.locator(".model-chip")).to_be_visible()
        expect(sup.locator(".badge", has_text="serving live")).to_have_count(1)
        sup.locator("#w-quality").fill("100")
        assert sup.locator("#w-cost").input_value() == "0" and sup.locator("#w-latency").input_value() == "0", "sliders did not rebalance"
        expect(sup.locator(".sum")).to_have_text("Total 100%")
        sup.locator("#w-cost").fill("60")
        q, c, l = (int(sup.locator(f"#w-{x}").input_value()) for x in ("quality", "cost", "latency"))
        assert (q, c, l) == (40, 60, 0) and q + c + l == 100, f"rebalance gave {q}/{c}/{l}"
        expect(sup.get_by_text("Ranking preview")).to_be_visible()  # 40/60/0 differs from any live weights the tests leave
        sup.screenshot(path=OUT / "5_model_routing.png", full_page=True)
        sup.get_by_role("button", name="Reset to live").click()
        expect(sup.get_by_text("Ranking under the live preferences")).to_be_visible()
    check("Model routing: 8 ranked LLMs, linked sliders always total 100%, live preview", models_page)

    analyst = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
    analyst.on("pageerror", lambda e: errors.append(str(e)))
    analyst.goto(SITE + "/")
    analyst.get_by_role("button", name="Create an account").click()
    analyst.screenshot(path=OUT / "0_register_form.png", full_page=True)
    check("student registers as an ANALYST (phone viewport)", lambda: register(analyst, "analyst"))

    def analyst_view():
        analyst.goto(f"{SITE}/claims/{a.claim}")
        expect(analyst.locator(".approval.decided")).to_contain_text("APPROVED", timeout=30_000)
        assert analyst.evaluate("document.documentElement.scrollWidth") <= 390, "horizontal scroll on phone"
        expect(analyst.get_by_role("button", name="Approve plan")).to_have_count(0)
    check("analyst sees the approved decision, cannot approve, no horizontal scroll", analyst_view)

    def analyst_models():
        analyst.goto(f"{SITE}/models")
        expect(analyst.locator("table.ranking tbody tr")).to_have_count(8, timeout=30_000)
        assert analyst.evaluate("document.documentElement.scrollWidth") <= 390, "horizontal scroll on phone"
    check("Model routing page works on a phone (no horizontal scroll)", analyst_models)
    analyst.screenshot(path=OUT / "4_phone.png", full_page=True)
    check("no uncaught page errors", lambda: (_ for _ in ()).throw(AssertionError(errors)) if errors else None)
    browser.close()

idp = boto3.client("cognito-idp")
pool = __import__("outputs").output("ClaimsWb-Foundation", "UserPoolId")
for uname in STUDENTS.values():  # remove the test students so the pool only holds real class accounts
    try:
        idp.admin_delete_user(UserPoolId=pool, Username=uname)
    except idp.exceptions.UserNotFoundException:
        pass

print(f"\n{sum(results)}/{len(results)} UI checks passed; screenshots in {OUT}")
sys.exit(0 if all(results) else 1)
