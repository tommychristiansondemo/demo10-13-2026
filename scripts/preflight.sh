#!/usr/bin/env bash
# Verifies everything that usually blocks a one-day deployment BEFORE anything is created:
# credentials, region, Docker arm64 builds, DNS zone + existing records, Bedrock model access, AgentCore availability.
source "$(dirname "$0")/lib/common.sh"
FAILED=0

step "AWS credentials (source, identity, expiry)"
"$PY" "$ROOT/scripts/credentials_check.py" >/dev/null 2>&1 && ok "credentials_check.py passed" || { "$PY" "$ROOT/scripts/credentials_check.py" || true; fail "credential check failed"; exit 1; }

step "AWS identity"
if ACCOUNT=$(account_id 2>/dev/null); then
  ok "account $ACCOUNT as $(aws sts get-caller-identity --query Arn --output text)"
  CONFIGURED=$(CFG account)
  if [[ -n "$CONFIGURED" && "$CONFIGURED" != "$ACCOUNT" ]]; then fail "cdk.json workbench.account=$CONFIGURED but credentials are for $ACCOUNT"; FAILED=1; fi
else fail "no working AWS credentials"; exit 1; fi
ok "region $REGION"

step "Local tooling"
for bin in node npm docker; do command -v $bin >/dev/null && ok "$bin $($bin --version 2>/dev/null | head -1)" || { fail "$bin missing"; FAILED=1; }; done
[[ -x "$PY" ]] && ok "python venv $("$PY" --version)" || { fail "missing .venv (python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt)"; FAILED=1; }
arm64_ok() { docker run --rm --platform linux/arm64 public.ecr.aws/docker/library/busybox:latest uname -m 2>/dev/null | grep -q aarch64; }
if ! arm64_ok; then
  # QEMU binfmt registration does not survive a reboot of this workstation; re-register it (no sudo needed).
  warn "arm64 emulation not registered (normal after a reboot): registering it now"
  docker run --privileged --rm tonistiigi/binfmt:qemu-v9.2.2 --install arm64 >/dev/null 2>&1 || true
fi
if arm64_ok; then ok "docker can build/run linux/arm64 (AgentCore Runtime requirement)"
else fail "docker cannot run arm64 images: docker run --privileged --rm tonistiigi/binfmt --install arm64"; FAILED=1; fi

step "DNS: $SITE_HOST in zone $ZONE_NAME"
ZID=$(zone_id)
if [[ -z "$ZID" || "$ZID" == "None" ]]; then fail "hosted zone $ZONE_NAME not found in this account"; FAILED=1
else
  ok "hosted zone $ZID"
  EXISTING=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZID" --query "ResourceRecordSets[?Name=='${SITE_HOST}.'].[Type,AliasTarget.DNSName||ResourceRecords[0].Value]" --output text)
  if [[ -n "$EXISTING" ]]; then
    if aws cloudformation describe-stacks --stack-name ClaimsWb-Web >/dev/null 2>&1; then ok "existing records belong to ClaimsWb-Web"
    else fail "records already exist for $SITE_HOST (owned by something else) -- remove them or change siteHostname:"; echo "$EXISTING" | sed 's/^/      /'; FAILED=1; fi
  else ok "no existing records for $SITE_HOST"; fi
  EXISTING=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZID" --query "ResourceRecordSets[?Name=='${INSIGHTS_HOST}.'].[Type]" --output text)
  if [[ -n "$EXISTING" ]] && ! aws cloudformation describe-stacks --stack-name ClaimsInsights >/dev/null 2>&1; then
    fail "records already exist for $INSIGHTS_HOST (owned by something else)"; FAILED=1
  else ok "$INSIGHTS_HOST is free or owned by ClaimsInsights"; fi
  NS=$(dig +short NS "$ZONE_NAME" 2>/dev/null | head -1 || true)
  [[ -n "$NS" ]] && ok "public NS resolves ($NS)" || warn "could not resolve NS for $ZONE_NAME (dig missing or delegation issue) -- ACM DNS validation needs working delegation"
fi

step "Amazon Bedrock model access"
"$PY" "$ROOT/scripts/check_models.py" "$MODEL_ID" || FAILED=1

step "Amazon Bedrock AgentCore"
if aws bedrock-agentcore-control list-agent-runtimes --max-results 5 >/dev/null 2>&1; then
  ok "AgentCore control plane reachable; existing runtimes: $(aws bedrock-agentcore-control list-agent-runtimes --query 'length(agentRuntimes)' --output text)"
else fail "cannot call bedrock-agentcore-control list-agent-runtimes (region / permissions / CLI version)"; FAILED=1; fi
echo "  - X-Ray resource policies in account: $(aws xray list-resource-policies --query 'length(ResourcePolicies)' --output text 2>/dev/null || echo '?') (quota 5; this app adds 1)"

step "Existing stacks"
for s in "$TOOLKIT_STACK" "${STACKS[@]}"; do
  st=$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "-")
  echo "  - $s: $st"
  [[ "$st" == *ROLLBACK_COMPLETE || "$st" == *FAILED ]] && { warn "$s is in $st: delete it before deploying"; }
done

echo
if [[ $FAILED -eq 0 ]]; then ok "preflight passed"; else fail "preflight found blockers (see above)"; exit 1; fi
