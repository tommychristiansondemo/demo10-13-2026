"""Record a real, live analysis run as the demo fallback (web/public/fallback/<claim>.ndjson).
The UI shows a "Replay recorded run" button when the file exists. Redeploy the web stack afterwards:

    .venv/bin/python scripts/capture_fallback.py CLM-24817 CLM-24835
    (cd web && npm run build) && npx cdk deploy ClaimsWb-Web -c account=... -c hostedZoneId=...   # or scripts/deploy.sh --skip-tests
"""
import hashlib
import json
import sys
from pathlib import Path

import httpx

from outputs import site_url
from smoke_test_auth import token

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "fallback"
OUT.mkdir(parents=True, exist_ok=True)
tok = token("claims.analyst")
for claim in sys.argv[1:] or ["CLM-24817"]:
    lines = []
    with httpx.stream("POST", f"{site_url()}/api/claims/{claim}/analyze", content="{}", timeout=300,
                      headers={"x-auth-token": tok, "content-type": "application/json",
                               "x-amz-content-sha256": hashlib.sha256(b"{}").hexdigest()}) as s:
        s.raise_for_status()
        lines = [line for line in s.iter_lines() if line.strip() and json.loads(line)["type"] != "ping"]
    done = json.loads(lines[-1])
    if done["type"] != "run_completed" or done["run"]["status"] != "PENDING_APPROVAL":
        sys.exit(f"{claim}: run did not complete cleanly, not saving ({lines[-1][:200]})")
    (OUT / f"{claim}.ndjson").write_text("\n".join(lines) + "\n")
    print(f"  ✓ {claim}: {len(lines)} events -> {OUT / (claim + '.ndjson')}")
