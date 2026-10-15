// Recommendation runs + human approval decisions in DynamoDB (pk = claimId, sk = runId).
// Local dev without a table falls back to an in-memory map.
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { config } from './config.js';
import type { DecisionRecord, RunRecord } from './events.js';

const doc = config.tableName
  ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }), { marshallOptions: { removeUndefinedValues: true } })
  : undefined;
const memory = new Map<string, RunRecord>();
const memKey = (c: string, r: string) => `${c}#${r}`;

export class ConflictError extends Error {}

export async function putRun(run: RunRecord): Promise<void> {
  if (!doc) return void memory.set(memKey(run.claimId, run.runId), structuredClone(run));
  await doc.send(new PutCommand({ TableName: config.tableName, Item: { pk: run.claimId, sk: run.runId, ...run } }));
}

export async function getRun(claimId: string, runId: string): Promise<RunRecord | undefined> {
  if (!doc) return memory.get(memKey(claimId, runId));
  const r = await doc.send(new GetCommand({ TableName: config.tableName, Key: { pk: claimId, sk: runId } }));
  return r.Item as RunRecord | undefined;
}

export async function listRuns(claimId: string, limit = 10): Promise<RunRecord[]> {
  if (!doc) {
    return [...memory.values()].filter((r) => r.claimId === claimId).sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, limit);
  }
  const r = await doc.send(
    new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'pk = :c',
      ExpressionAttributeValues: { ':c': claimId },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (r.Items ?? []) as RunRecord[];
}

/** Record a supervisor decision; only a PENDING_APPROVAL run can be decided (first decision wins). */
export async function decide(claimId: string, runId: string, decision: DecisionRecord): Promise<RunRecord> {
  if (!doc) {
    const run = memory.get(memKey(claimId, runId));
    if (!run) throw new ConflictError('Run not found');
    if (run.status !== 'PENDING_APPROVAL') throw new ConflictError(`Run is already ${run.status}`);
    Object.assign(run, { status: decision.decision, decision });
    return run;
  }
  try {
    const r = await doc.send(
      new UpdateCommand({
        TableName: config.tableName,
        Key: { pk: claimId, sk: runId },
        UpdateExpression: 'SET #s = :s, #d = :d',
        ConditionExpression: 'attribute_exists(pk) AND #s = :pending',
        ExpressionAttributeNames: { '#s': 'status', '#d': 'decision' },
        ExpressionAttributeValues: { ':s': decision.decision, ':d': decision, ':pending': 'PENDING_APPROVAL' },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return r.Attributes as RunRecord;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw new ConflictError('Run not found or already decided');
    throw err;
  }
}
