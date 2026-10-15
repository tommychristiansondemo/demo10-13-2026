#!/usr/bin/env bash
# Run the whole app locally: both MCP servers, the API (auth bypassed) and the Vite dev server.
#   scripts/local_dev.sh          -> http://localhost:5173
# The "Run AI analysis" button additionally needs AWS credentials with Bedrock access in this shell.
source "$(dirname "$0")/lib/common.sh"
cd "$ROOT"
trap 'kill 0' EXIT
(cd mcp_servers/claims_policy && PORT=8001 "$PY" server.py) &
(cd mcp_servers/damage_repair && PORT=8002 "$PY" server.py) &
LOCAL_DEV=1 CLAIMS_MCP_URL=http://127.0.0.1:8001/mcp DAMAGE_MCP_URL=http://127.0.0.1:8002/mcp MODEL_ID="$MODEL_ID" npx tsx services/api/src/local-server.ts &
(cd web && npx vite --port 5173 --strictPort) &
wait
