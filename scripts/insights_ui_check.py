"""Headless browser walkthrough of the DEPLOYED Class Insights app, reached the way a student would: from the Workbench
header link. Screenshots go to ./test-results/insights_*.png.

    .venv/bin/python scripts/insights_ui_check.py [--headed]
"""
import argparse
import json
import sys
from pathlib import Path

import boto3
from playwright.sync_api import expect, sync_playwright

from outputs import CDK, site_url

ap = argparse.ArgumentParser()
ap.add_argument("--headed", action="store_true")
a = ap.parse_args()
OUT = Path(__file__).resolve().parents[1] / "test-results"
OUT.mkdir(exist_ok=True)
WB, INS = site_url(), f"https://{CDK['insightsHostname']}"
pw = json.loads(boto3.client("secretsmanager").get_secret_value(SecretId="claims-workbench/demo-users/claims.analyst")["SecretString"])["password"]
results = []


def check(label, fn):
    try:
        fn()
        results.append(True)
        print(f"  ✓ {label}")
    except Exception as e:  # noqa: BLE001
        results.append(False)
        print(f"  ✗ {label}: {str(e).splitlines()[0][:200]}")


def managed_login(page):
    page.wait_for_url("**/login**", timeout=20_000)
    page.locator("input[name=username]").fill("claims.analyst")
    if page.locator("input[name=password]").count() == 0 or not page.locator("input[name=password]").is_visible():
        page.get_by_role("button", name="Next").click()
    page.locator("input[name=password]").fill(pw)
    page.locator("button[type=submit]").first.click()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=not a.headed)
    errors = []
    page = browser.new_context(viewport={"width": 1440, "height": 1000}).new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    def workbench_link():
        page.goto(WB + "/")
        expect(page.locator(".insights-cta")).to_be_visible()
        page.get_by_role("button", name="Sign in").click()
        managed_login(page)
        page.wait_for_url(WB + "/**", timeout=20_000)
        link = page.get_by_role("link", name="Class Insights ↗")
        expect(link).to_have_attribute("href", INS)
        link.click()
        page.wait_for_url(INS + "/**")
    check("Workbench header links to Class Insights (sign-in page has the link too)", workbench_link)

    def sign_in():
        page.get_by_role("button", name="Sign in with your class account").click()
        page.wait_for_url(INS + "/**", timeout=30_000)  # Cognito session cookie from the Workbench: no second password prompt
        expect(page.locator(".user-name")).to_have_text("claims.analyst", timeout=20_000)
    check("same account signs in to Class Insights (single sign-on via the shared Cognito pool)", sign_in)

    def ask():
        page.get_by_role("button", name="How many different types of AWS resources are deployed right now?").click()
        expect(page.locator(".reasoning").first).to_be_visible(timeout=60_000)
        expect(page.locator(".tool-step code", has_text="get_live_inventory").first).to_be_visible(timeout=90_000)
        expect(page.locator(".msg.assistant .meta")).to_be_visible(timeout=180_000)
        expect(page.locator(".msg.assistant .answer")).to_contain_text("resource", timeout=5_000)
    check("chatbot streams reasoning, calls a live tool and answers", ask)
    page.screenshot(path=OUT / "insights_1_ask.png", full_page=True)

    def knowledge():
        page.get_by_role("link", name="Project knowledge").click()
        expect(page.locator(".knowledge h1")).to_contain_text("Project knowledge", timeout=20_000)
        expect(page.locator(".source-note")).to_contain_text("projectknowledge.md")
    check("Project knowledge page renders projectknowledge.md from S3", knowledge)
    page.screenshot(path=OUT / "insights_2_knowledge.png")

    def inventory():
        page.get_by_role("link", name="Live inventory").click()
        expect(page.locator(".stat")).not_to_have_count(0, timeout=30_000)
        expect(page.get_by_text("claims_policy_mcp").first).to_be_visible()
    check("Live inventory shows stacks, resource types and both AgentCore runtimes", inventory)
    page.screenshot(path=OUT / "insights_3_inventory.png", full_page=True)

    def reasoning():
        page.get_by_role("link", name="LLM reasoning logs").click()
        expect(page.locator(".run").first).to_be_visible(timeout=30_000)
        expect(page.locator(".app-badge", has_text="Claims Workbench agent").first).to_be_visible()
        expect(page.locator(".app-badge", has_text="Class Insights chatbot").first).to_be_visible()
        expect(page.locator(".block.reason pre").first).to_be_visible()
    check("Reasoning logs show both apps' prompts and model reasoning", reasoning)
    page.screenshot(path=OUT / "insights_4_reasoning.png")

    def costs():
        page.get_by_role("link", name="Costs").click()
        expect(page.locator(".calls-table tbody tr").first).to_be_visible(timeout=60_000)
        expect(page.get_by_text("Spend by model")).to_be_visible()
        expect(page.get_by_text("Month to date by service")).to_be_visible(timeout=60_000)
        expect(page.locator(".day").first).to_be_visible()
    check("Costs page: every LLM call priced, spend by model, Cost Explorer summary", costs)
    page.screenshot(path=OUT / "insights_5_costs.png", full_page=True)

    def logs():
        page.get_by_role("link", name="Logs explorer").click()
        page.get_by_role("button", name="MCP tool calls").click()
        expect(page.locator(".events li").first).to_be_visible(timeout=30_000)
    check("Logs explorer preset returns MCP tool-call events", logs)

    phone = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
    phone.on("pageerror", lambda e: errors.append(str(e)))

    def phone_view():
        phone.goto(INS + "/")
        expect(phone.get_by_role("button", name="Sign in with your class account")).to_be_visible()
        assert phone.evaluate("document.documentElement.scrollWidth") <= 390, "horizontal scroll on phone"
    check("phone layout: no horizontal scroll", phone_view)
    check("no uncaught page errors", lambda: (_ for _ in ()).throw(AssertionError(errors)) if errors else None)
    browser.close()

print(f"\n{sum(results)}/{len(results)} Class Insights UI checks passed; screenshots in {OUT}")
sys.exit(0 if all(results) else 1)
