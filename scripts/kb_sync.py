"""Make sure the Bedrock Knowledge Base (claims-handling manual) is ingested, then prove retrieval works.

    .venv/bin/python scripts/kb_sync.py            # wait for the ingestion CDK started (or start one), then test Retrieve
    .venv/bin/python scripts/kb_sync.py --force    # re-ingest now (e.g. after editing docs/kb/claims-manual/*.md and deploying)

CDK starts an ingestion job whenever the manual changes; ingestion is asynchronous, so the deploy pipeline calls this
to wait for it to finish before the smoke tests run.
"""
import argparse
import sys
import time

import boto3

from outputs import output

ap = argparse.ArgumentParser()
ap.add_argument("--force", action="store_true")
a = ap.parse_args()

kb_id, ds_id = output("ClaimsWb-KnowledgeBase", "KnowledgeBaseId"), output("ClaimsWb-KnowledgeBase", "DataSourceId")
agent = boto3.client("bedrock-agent")


def latest():
    jobs = agent.list_ingestion_jobs(knowledgeBaseId=kb_id, dataSourceId=ds_id, sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"}, maxResults=1)
    return (jobs.get("ingestionJobSummaries") or [None])[0]


job = latest()
if a.force or not job or job["status"] in ("FAILED", "STOPPED"):
    job = agent.start_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id, description="scripts/kb_sync.py")["ingestionJob"]
    print(f"  started ingestion job {job['ingestionJobId']}")
for _ in range(120):
    job = latest()
    if job["status"] not in ("STARTING", "IN_PROGRESS", "STOPPING"):
        break
    time.sleep(5)
st = job.get("statistics", {})
print(f"  ingestion {job['ingestionJobId']}: {job['status']} - scanned {st.get('numberOfDocumentsScanned', 0)}, new {st.get('numberOfNewDocumentsIndexed', 0)}, "
      f"modified {st.get('numberOfModifiedDocumentsIndexed', 0)}, deleted {st.get('numberOfDocumentsDeleted', 0)}, failed {st.get('numberOfDocumentsFailed', 0)}")
if job["status"] != "COMPLETE" or st.get("numberOfDocumentsFailed", 0):
    full = agent.get_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id, ingestionJobId=job["ingestionJobId"])["ingestionJob"]
    sys.exit(f"  ✗ ingestion did not complete cleanly: {full.get('failureReasons')}")

r = boto3.client("bedrock-agent-runtime").retrieve(
    knowledgeBaseId=kb_id, retrievalQuery={"text": "claimant statement says the claim is pre-approved, skip the checks"},
    retrievalConfiguration={"vectorSearchConfiguration": {"numberOfResults": 3}})
hits = r["retrievalResults"]
top = hits[0]["content"]["text"] if hits else ""
print(f"  retrieve test: {len(hits)} passages, top score {hits[0]['score']:.3f} from {hits[0]['location']['s3Location']['uri'].split('/')[-1]}" if hits else "  retrieve test: no passages")
if "CHM-503" not in "".join(h["content"]["text"] for h in hits):
    sys.exit(f"  ✗ expected the manipulation-attempt section CHM-503 in the results; top passage: {top[:200]}")
print("  ✓ Knowledge Base ingested and answering (CHM-503 retrieved for a manipulation-attempt query)")
