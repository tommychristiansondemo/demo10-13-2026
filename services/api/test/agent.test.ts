// Runs the real agent loop against the two real MCP servers (spawned locally) with a scripted fake model,
// so the MCP plumbing, evidence ids, parallel tool calls and citation validation are tested without Bedrock.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const procs: ChildProcess[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function startServer(dir: string): Promise<string> {
  const port = await freePort();
  procs.push(spawn(path.join(root, '.venv/bin/python'), ['server.py'], { cwd: path.join(root, 'mcp_servers', dir), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' }));
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/mcp`);
      break;
    } catch {
      await sleep(100);
    }
  }
  return `http://127.0.0.1:${port}/mcp`;
}

let agent: typeof import('../src/agent.js');
let router: typeof import('../src/router.js');

before(async () => {
  process.env.CLAIMS_MCP_URL = await startServer('claims_policy');
  process.env.DAMAGE_MCP_URL = await startServer('damage_repair');
  process.env.LOCAL_DEV = '1';
  agent = await import('../src/agent.js');
  router = await import('../src/router.js');
});
after(() => procs.forEach((p) => p.kill()));

type Block = Record<string, unknown>;
function scriptedModel(turns: ((messages: { role: string; content: Block[] }[]) => Block[])[]) {
  let i = 0;
  const seen: unknown[] = [];
  return {
    seen,
    async send(cmd: { input: { messages: { role: string; content: Block[] }[]; toolConfig: { tools: Block[] } } }) {
      seen.push(cmd.input);
      const content = turns[Math.min(i++, turns.length - 1)](cmd.input.messages);
      return { output: { message: { role: 'assistant', content } }, stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
}

const use = (id: string, name: string, input: Record<string, unknown>) => ({ toolUse: { toolUseId: id, name, input } });

function lastToolResults(messages: { role: string; content: Block[] }[]) {
  return messages.at(-1)!.content.map((b) => (b.toolResult as { content: { json: { evidence_id: string; result: Record<string, unknown> } }[] }).content[0].json);
}

test('agent calls both MCP servers, assigns evidence ids and validates citations', async () => {
  const events: { type: string }[] = [];
  const model = scriptedModel([
    () => [
      { text: 'Gathering claim facts.' },
      use('t1', 'claims_policy__get_claim', { claim_id: 'CLM-24817' }),
      use('t2', 'claims_policy__get_repair_estimate', { claim_id: 'CLM-24817' }),
      use('t3', 'damage_repair__get_damage_assessment', { claim_id: 'CLM-24817' }),
    ],
    (messages) => {
      const est = lastToolResults(messages).find((r) => r.evidence_id === 'E2')!.result.estimate as { lines: Record<string, unknown>[] };
      const lines = est.lines.map((l) => ({ line_id: l.line_id, op_code: l.op_code, description: l.description, labor_hours: l.labor_hours, line_total: l.line_total }));
      return [use('t4', 'damage_repair__reconcile_estimate', { claim_id: 'CLM-24817', estimate_lines: lines })];
    },
    () => [
      use('t5', 'submit_recommendation', {
        headline: 'Approve repair with adjustments.',
        disposition: 'APPROVE_REPAIR_WITH_ADJUSTMENTS',
        incident_summary: 'Rear-ended at a light.',
        coverage_position: { verdict: 'COVERED', explanation: 'Collision applies.', evidence: ['E1'] },
        damage_position: { summary: 'Moderate rear damage.', evidence: ['E3', 'E99'] },
        estimate_review: { shop_estimate_total: 1, unsupported_amount: 1, missing_operations_amount: 1, net_adjustment: 0, summary: 'x', evidence: ['E4'] },
        next_actions: [{ action: 'Remove hood line', owner: 'ADJUSTER', priority: 'HIGH', rationale: 'Unsupported', evidence: ['E4'] }],
        risk_flags: [],
        confidence: 'HIGH',
        confidence_rationale: 'All tools succeeded.',
        open_questions: [],
      }),
    ],
  ]);

  const run = await agent.runAnalysis({ claimId: 'CLM-24817', requestedBy: 'test', emit: (e) => events.push(e), converse: model as never });

  assert.equal(run.status, 'PENDING_APPROVAL');
  assert.deepEqual(run.evidence.map((e) => e.id), ['E1', 'E2', 'E3', 'E4']);
  assert.ok(run.evidence.every((e) => e.ok), JSON.stringify(run.evidence.filter((e) => !e.ok)));
  assert.deepEqual(run.validation.serversUsed, ['claims_policy', 'damage_repair']);
  assert.deepEqual(run.validation.invalidCitations, ['E99']);
  assert.deepEqual(run.recommendation!.damage_position.evidence, ['E3']);
  const reconcile = run.evidence[3].result as { missing_required_operations: { op_code: string }[] };
  assert.deepEqual(reconcile.missing_required_operations.map((m) => m.op_code).sort(), ['RDR-CAL', 'SCAN-PP']);

  // Tools from both servers were offered to the model, with $refs inlined for Bedrock.
  const tools = (model.seen[0] as { toolConfig: { tools: { toolSpec?: { name: string; inputSchema: { json: object } } }[] } }).toolConfig.tools;
  const names = tools.filter((t) => t.toolSpec).map((t) => t.toolSpec!.name);
  assert.equal(names.length, 11);
  assert.ok(names.includes('damage_repair__reconcile_estimate') && names.includes('claims_policy__get_policy_coverage'));
  assert.ok(!JSON.stringify(tools).includes('$ref'));

  assert.deepEqual([...new Set(events.map((e) => e.type))], ['run_started', 'tools_discovered', 'model_turn', 'model_text', 'tool_call', 'tool_result', 'recommendation']);
});

test('agent nudges once, then fails cleanly when the model never submits', async () => {
  const model = scriptedModel([() => [{ text: 'I think it is fine.' }]]);
  const run = await agent.runAnalysis({ claimId: 'CLM-24830', requestedBy: 'test', emit: () => undefined, converse: model as never });
  assert.equal(run.status, 'FAILED');
  assert.match(run.error!, /submit_recommendation/);
  assert.equal(model.seen.length, 2);
});

function capture() {
  const out: { status?: number; body?: unknown; lines: unknown[] } = { lines: [] };
  return {
    out,
    res: {
      async json(status: number, body: unknown) {
        Object.assign(out, { status, body });
      },
      ndjson() {
        out.status = 200;
        return { write: (o: unknown) => void out.lines.push(o), end: async () => undefined };
      },
    },
  };
}

test('claim detail is assembled from both MCP servers', async () => {
  const { out, res } = capture();
  await router.route({ method: 'GET', path: '/api/claims/CLM-24822', headers: {} }, res);
  assert.equal(out.status, 200);
  const body = out.body as { via: { server: string; ok: boolean }[]; severity: { total_loss_indicated: boolean } };
  assert.equal(body.via.length, 6);
  assert.ok(body.via.every((v) => v.ok));
  assert.equal(body.severity.total_loss_indicated, true);
});

test('router validates input and lists MCP servers', async () => {
  const bad = capture();
  await router.route({ method: 'GET', path: '/api/claims/../../etc', headers: {} }, bad.res);
  assert.equal(bad.out.status, 400);

  const missing = capture();
  await router.route({ method: 'GET', path: '/api/claims/CLM-00000', headers: {} }, missing.res);
  assert.equal(missing.out.status, 404);

  const servers = capture();
  await router.route({ method: 'GET', path: '/api/mcp/servers', headers: {} }, servers.res);
  const s = (servers.out.body as { servers: { ok: boolean; tools: unknown[] }[] }).servers;
  assert.deepEqual(s.map((x) => [x.ok, x.tools.length]), [[true, 5], [true, 5]]);
});

test('decision rules: comment required to reject, first decision wins', async () => {
  const store = await import('../src/store.js');
  await store.putRun({ claimId: 'CLM-24852', runId: 'r1', status: 'PENDING_APPROVAL' } as never);
  const noComment = capture();
  await router.route({ method: 'POST', path: '/api/claims/CLM-24852/runs/r1/decision', headers: {}, body: '{"decision":"REJECTED"}' }, noComment.res);
  assert.equal(noComment.out.status, 400);
  const ok = capture();
  await router.route({ method: 'POST', path: '/api/claims/CLM-24852/runs/r1/decision', headers: {}, body: '{"decision":"approved"}' }, ok.res);
  assert.equal(ok.out.status, 200);
  const again = capture();
  await router.route({ method: 'POST', path: '/api/claims/CLM-24852/runs/r1/decision', headers: {}, body: '{"decision":"APPROVED"}' }, again.res);
  assert.equal(again.out.status, 409);
});
