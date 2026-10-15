#!/usr/bin/env bash
# Full deployment: Claude 5.x activation -> preflight -> build web -> own CDK bootstrap -> deploy all stacks -> demo users -> smoke test -> independence check.
#   scripts/deploy.sh [--skip-preflight] [--skip-tests]
source "$(dirname "$0")/lib/common.sh"
SKIP_PREFLIGHT=0; SKIP_TESTS=0
for a in "$@"; do case $a in --skip-preflight) SKIP_PREFLIGHT=1;; --skip-tests) SKIP_TESTS=1;; esac; done
cd "$ROOT"

step "Step 0: activate Claude 5.x models (account-level; idempotent)"
"$PY" "$ROOT/scripts/enable_models.py" || warn "not every Claude 5.x model is usable yet; the app uses modelId=$MODEL_ID"

[[ $SKIP_PREFLIGHT -eq 1 ]] || "$ROOT/scripts/preflight.sh"
ACCOUNT=$(account_id); ZID=$(zone_id)
CTX=(-c "account=$ACCOUNT" -c "hostedZoneId=$ZID" -c "modelId=$MODEL_ID")

step "Unit + protocol tests"
"$PY" -m pytest -q mcp_servers/tests
npm test --silent >/dev/null && ok "orchestrator tests passed"

step "Build web apps"
(cd web && npm ci --silent && npm run build --silent) && ok "web/dist built (Claims Workbench)"
(cd insights-web && npm ci --silent && npm run build --silent) && ok "insights-web/dist built (Class Insights)"

step "CDK bootstrap ($TOOLKIT_STACK, qualifier $QUALIFIER)"
if aws cloudformation describe-stacks --stack-name "$TOOLKIT_STACK" >/dev/null 2>&1; then ok "already bootstrapped"
else npx cdk bootstrap "aws://$ACCOUNT/$REGION" --qualifier "$QUALIFIER" --toolkit-stack-name "$TOOLKIT_STACK" "${CTX[@]}"; fi

step "Deploy stacks"
# Always deploy --all (not --exclusively): stacks export values to each other.
npx cdk deploy --all --require-approval never --toolkit-stack-name "$TOOLKIT_STACK" --outputs-file "$ROOT/cdk-outputs.json" "${CTX[@]}"

step "Demo users"
"$PY" scripts/seed_users.py

step "Bedrock Knowledge Base ingestion (claims-handling manual)"
"$PY" scripts/kb_sync.py

if [[ $SKIP_TESTS -eq 0 ]]; then
  step "Smoke test (deployed)"
  "$PY" scripts/smoke_test.py
fi
step "Publish projectknowledge.md (Class Insights knowledge base)"
"$PY" scripts/publish_knowledge.py

if [[ $SKIP_TESTS -eq 0 ]]; then
  step "Class Insights smoke test"
  "$PY" scripts/insights_smoke.py
fi

step "Workstation independence"
"$PY" scripts/verify_independence.py
step "Done: https://$SITE_HOST and https://$INSIGHTS_HOST"
