"""Before class: delete all stored analysis runs/decisions so every claim starts fresh."""
import boto3

import outputs  # noqa: F401  (defaults the region from cdk.json)

t = boto3.resource("dynamodb").Table("claims-workbench-runs")
n = 0
for page in boto3.client("dynamodb").get_paginator("scan").paginate(TableName=t.name, ProjectionExpression="pk, sk"):
    with t.batch_writer() as w:
        for item in page["Items"]:
            w.delete_item(Key={"pk": item["pk"]["S"], "sk": item["sk"]["S"]})
            n += 1
print(f"  ✓ deleted {n} runs")
