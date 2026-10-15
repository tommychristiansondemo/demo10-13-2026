#!/usr/bin/env bash
# Offline readiness check: everything this workstation needs BEFORE AWS credentials exist. Makes no AWS calls.
#   scripts/ready_check.sh [--fast]   (--fast skips the image builds and the CDK synth)
source "$(dirname "$0")/lib/common.sh"
cd "$ROOT"
FAST=0; [[ "${1:-}" == "--fast" ]] && FAST=1
FAILED=0
need() { if "$@" >/dev/null 2>&1; then ok "$LABEL"; else fail "$LABEL"; FAILED=1; fi; }

step "Toolchain"
for bin in node npm docker aws python3; do command -v $bin >/dev/null && ok "$bin $($bin --version 2>&1 | head -1)" || { fail "$bin missing"; FAILED=1; }; done
LABEL="aws CLI supports 'aws login' (temporary credentials)" need aws login help
LABEL="docker daemon running" need docker info
LABEL="python venv with boto3/mcp/playwright" need "$PY" -c "import boto3, mcp, playwright, pytest"
LABEL="playwright chromium installed" need "$PY" -c "from playwright.sync_api import sync_playwright as s; p=s().start(); b=p.chromium.launch(); b.close(); p.stop()"
LABEL="node_modules (CDK, esbuild, tsx, MCP SDK)" need test -x node_modules/.bin/cdk -a -x node_modules/.bin/esbuild -a -d node_modules/@modelcontextprotocol/sdk
LABEL="web/node_modules" need test -d web/node_modules/react

step "Docker arm64 (AgentCore Runtime runs linux/arm64)"
arm64_ok() { docker run --rm --platform linux/arm64 public.ecr.aws/docker/library/busybox:latest uname -m 2>/dev/null | grep -q aarch64; }
if ! arm64_ok; then
  warn "arm64 emulation not registered (normal after a reboot): registering it now"
  docker run --privileged --rm tonistiigi/binfmt:qemu-v9.2.2 --install arm64 >/dev/null 2>&1 || true
fi
LABEL="docker runs linux/arm64 containers" need arm64_ok
if [[ $FAST -eq 0 ]]; then
  for s in claims_policy damage_repair; do
    LABEL="$s image builds for linux/arm64 (warms the layer cache CDK reuses)" need docker build --platform linux/arm64 -t "claimswb/$s:staged" "mcp_servers/$s"
  done
fi

step "Tests and build"
LABEL="pytest: MCP tools + protocol (both servers)" need "$PY" -m pytest -q mcp_servers/tests
LABEL="node:test: agent loop against real MCP servers" need npm test --silent
LABEL="typecheck (API + infra + web)" need npm run typecheck --silent
LABEL="web build" need bash -c "cd web && npm run build --silent"
if [[ $FAST -eq 0 ]]; then
  LABEL="cdk synth of all 5 stacks (placeholder zone id, no AWS calls)" need npx cdk synth --quiet -c hostedZoneId=Z0000000000000000000 -o "$ROOT/cdk.out"
  rm -rf "$ROOT/cdk.out"
fi

step "Config"
ok "account $(CFG account) · region $REGION · https://$SITE_HOST · model $MODEL_ID"
echo
if [[ $FAILED -eq 0 ]]; then ok "workstation is staged: waiting only for AWS credentials"; else fail "not ready (see above)"; exit 1; fi
