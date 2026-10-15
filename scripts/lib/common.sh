# Shared settings for the deploy/teardown scripts. Source this file.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CFG() { node -e "const c=require('$ROOT/cdk.json').context; const w=c.workbench; console.log(process.argv[1]==='qualifier'?c['@aws-cdk/core:bootstrapQualifier']:w[process.argv[1]])" "$1"; }
REGION="$(CFG region)"
QUALIFIER="$(CFG qualifier)"
ZONE_NAME="$(CFG hostedZoneName)"
SITE_HOST="$(CFG siteHostname)"
MODEL_ID="${MODEL_ID:-$(CFG modelId)}"  # override: MODEL_ID=us.anthropic.claude-... scripts/deploy.sh
TOOLKIT_STACK="ClaimsWb-CDKToolkit"
STACKS=(ClaimsWb-Foundation ClaimsWb-McpRuntimes ClaimsWb-KnowledgeBase ClaimsWb-Api ClaimsWb-Web ClaimsWb-Observability ClaimsInsights)
INSIGHTS_HOST="$(CFG insightsHostname)"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""
PY="$ROOT/.venv/bin/python"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
account_id() { aws sts get-caller-identity --query Account --output text; }
zone_id() { aws route53 list-hosted-zones-by-name --dns-name "$ZONE_NAME" --query "HostedZones[?Name=='${ZONE_NAME}.'] | [0].Id" --output text | sed 's#/hostedzone/##'; }
