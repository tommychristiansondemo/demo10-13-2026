#!/usr/bin/env bash
# Wrapper: scripts/teardown.sh [--with-bootstrap] [--dry-run]
source "$(dirname "$0")/lib/common.sh"
cd "$ROOT/scripts" && exec "$PY" teardown.py "$@"
