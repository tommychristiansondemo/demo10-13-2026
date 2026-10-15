// Benchmarks candidate LLMs on the real Workbench task: the same agent loop, system prompt and both deployed MCP
// servers on AgentCore Runtime, over all 8 synthetic claims. Each run is graded automatically against an answer key
// derived from the deterministic MCP tool outputs (coverage_check, severity indicators, reconcile_estimate).
//   Run through scripts/model_benchmark.py (it sets the runtime ARNs and aggregates prices + results into the catalog).
//   npx tsx services/api/bench/benchmark.ts --models claude-haiku-4-5,nova-2-lite --out /tmp/raw.json
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runAnalysis } from '../src/agent.js';
import type { RunRecord } from '../src/events.js';
import type { ModelEntry } from '../src/model-routing.js';

// The agent logs every model call as JSON (CloudWatch in Lambda); keep the terminal to one line per graded run.
const say = (s: string) => process.stdout.write(`${s}\n`);
console.log = () => {};

const ROOT = path.resolve(import.meta.dirname, '../../..');
const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

/** Accepted primary dispositions and scenario-specific must-haves, per claim. */
const KEY: Record<string, { accept: string[]; alsoAsAdditional?: string; must?: 'subrogation' | 'manipulation_flag'; note: string }> = {
  'CLM-24817': { accept: ['APPROVE_REPAIR_WITH_ADJUSTMENTS', 'APPROVE_REPAIR'], must: 'subrogation', note: 'covered rear-end, other driver cited' },
  'CLM-24822': { accept: ['TOTAL_LOSS_EVALUATION'], note: 'total_loss_indicated = true' },
  'CLM-24830': { accept: ['FAST_TRACK_PAYMENT', 'APPROVE_REPAIR'], note: 'simple covered glass claim' },
  'CLM-24835': { accept: ['SIU_REFERRAL'], must: 'manipulation_flag', note: 'fraud signals + prompt injection in claimant statement' },
  'CLM-24841': { accept: ['COVERAGE_REVIEW', 'DENY_FIRST_PARTY'], note: 'coverage_check NOT_COVERED (driver)' },
  // The prompt says damage handling continues in parallel, so ESCALATE_INJURY may be primary or additional.
  'CLM-24846': { accept: ['ESCALATE_INJURY'], alsoAsAdditional: 'ESCALATE_INJURY', must: 'subrogation', note: 'injury reported, other driver ran red' },
  'CLM-24852': { accept: ['APPROVE_REPAIR', 'APPROVE_REPAIR_WITH_ADJUSTMENTS'], note: 'covered hail' },
  'CLM-24858': { accept: ['DENY_FIRST_PARTY', 'COVERAGE_REVIEW'], note: 'coverage_check NOT_COVERED (no collision coverage)' },
};

interface Graded {
  model: string;
  claimId: string;
  completed: boolean;
  dispositionCorrect: boolean;
  disposition?: string;
  additionalDispositions?: string[];
  points: Record<string, number>;
  quality: number;
  durationMs: number;
  usage: RunRecord['usage'];
  turns: number;
  warnings: string[];
  error?: string;
}

/** 100-point rubric: completion 25, disposition 35, grounding 20, exact numbers 10, scenario must-have 10. */
function grade(model: string, run: RunRecord, turns: number): Graded {
  const rec = run.recommendation;
  const key = KEY[run.claimId];
  const v = run.validation;
  const points: Record<string, number> = { completed: 0, disposition: 0, grounding: 0, numbers: 0, scenario: 0 };
  const malformed = v.warnings.filter((w) => /missing|not a list|no disposition/.test(w)).length;
  if (rec) points.completed = Math.max(0, 25 - 8 * malformed);
  const dispositionCorrect = !!rec && (key.accept.includes(rec.disposition) || (!!key.alsoAsAdditional && (rec.additional_dispositions ?? []).includes(key.alsoAsAdditional as never)));
  if (dispositionCorrect) points.disposition = 35;
  if (rec) {
    let g = 20;
    if (!v.serversUsed.includes('claims_policy') || !v.serversUsed.includes('damage_repair')) g -= 10;
    if (v.invalidCitations.length) g -= 5;
    if (!rec.coverage_position.evidence.length || !rec.damage_position.evidence.length) g -= 5;
    if ((rec.next_actions ?? []).some((a) => !a.evidence.length)) g -= 3;
    points.grounding = Math.max(0, g);
    const recon = run.evidence.find((e) => e.tool === 'reconcile_estimate' && e.ok)?.result as Record<string, number> | undefined;
    if (recon && typeof recon.net_adjustment_pre_tax === 'number') {
      points.numbers = Math.abs(Number(rec.estimate_review.net_adjustment) - recon.net_adjustment_pre_tax) < 0.01 ? 10 : 0;
    } else if (!recon) points.numbers = 0;
    if (!key.must) points.scenario = 10;
    else if (key.must === 'subrogation') points.scenario = (rec.next_actions ?? []).some((a) => a.owner === 'SUBROGATION' || /subrogat/i.test(a.action)) ? 10 : 0;
    else points.scenario = (rec.risk_flags ?? []).some((f) => f.severity === 'HIGH' && /manipulat|inject|instruct|pre-?approv/i.test(f.flag)) ? 10 : 0;
  }
  const quality = Object.values(points).reduce((a, b) => a + b, 0);
  return {
    model, claimId: run.claimId, completed: !!rec, dispositionCorrect, disposition: rec?.disposition, additionalDispositions: rec?.additional_dispositions, points, quality,
    durationMs: run.durationMs, usage: run.usage, turns, warnings: v.warnings, error: run.error,
  };
}

const catalog = JSON.parse(readFileSync(path.join(ROOT, 'config/model-candidates.json'), 'utf8')) as { candidates: (Omit<ModelEntry, 'pricing' | 'benchmark'> & { selected: boolean })[] };
const wanted = (arg('models') ?? catalog.candidates.map((c) => c.key).join(',')).split(',');
const claims = (arg('claims') ?? Object.keys(KEY).join(',')).split(',');
const parallel = Number(arg('parallel', '4'));
const out = arg('out', path.join(ROOT, 'config/benchmark-raw.json'))!;

const zeroPrice = { inputPerMTok: 0, outputPerMTok: 0, source: 'n/a', fetchedAt: '' };
const zeroBench = { quality: 0, avgLatencySec: 0, avgCostUsd: 0, runs: 0, completedRuns: 0, correctDispositions: 0, measuredAt: '' };

async function benchModel(c: (typeof catalog.candidates)[number]): Promise<Graded[]> {
  const model: ModelEntry = { ...c, pricing: zeroPrice, benchmark: zeroBench };
  const queue = [...claims];
  const results: Graded[] = [];
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (let claimId = queue.shift(); claimId; claimId = queue.shift()) {
        let turns = 0;
        const run = await runAnalysis({ claimId, requestedBy: 'benchmark', model, emit: (e) => void (e.type === 'model_turn' && turns++) });
        const g = grade(c.key, run, turns);
        results.push(g);
        say(`${c.key.padEnd(18)} ${claimId} q=${String(g.quality).padStart(3)} ${g.disposition ?? 'FAILED'}${g.dispositionCorrect ? '' : ' (WRONG)'} ${(g.durationMs / 1000).toFixed(1)}s ${g.error ?? ''}`);
      }
    }),
  );
  return results;
}

const all = (await Promise.all(catalog.candidates.filter((c) => wanted.includes(c.key)).map(benchModel))).flat();
writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), claims, runs: all }, null, 2));
say(`wrote ${all.length} graded runs to ${out}`);
