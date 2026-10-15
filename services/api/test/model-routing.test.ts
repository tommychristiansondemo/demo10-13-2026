import assert from 'node:assert/strict';
import { test } from 'node:test';
import catalog from '../../../config/model-catalog.json' with { type: 'json' };
import { costUsd, decide, rankModels, rebalance, validateWeights, type ModelCatalog, type Weights } from '../src/model-routing.js';

const cat = catalog as ModelCatalog;
const sum = (w: Weights) => w.quality + w.cost + w.latency;

test('catalog has eight models with prices and benchmark results', () => {
  assert.equal(cat.models.length, 8);
  for (const m of cat.models) {
    assert.ok(m.pricing.inputPerMTok > 0 && m.pricing.outputPerMTok > 0, m.key);
    assert.ok(m.benchmark.runs >= 8 && m.benchmark.avgLatencySec > 0 && m.benchmark.avgCostUsd > 0, m.key);
  }
});

test('validateWeights accepts integers summing to 100 and rejects everything else', () => {
  assert.deepEqual(validateWeights({ quality: 50, cost: 25, latency: 25 }), { quality: 50, cost: 25, latency: 25 });
  assert.throws(() => validateWeights({ quality: 50, cost: 25, latency: 24 }), /add up to 100/);
  assert.throws(() => validateWeights({ quality: 50.5, cost: 25, latency: 24.5 }), /integer/);
  assert.throws(() => validateWeights({ quality: 120, cost: -20, latency: 0 }), /0 to 100/);
  assert.throws(() => validateWeights({ quality: 100 }), /cost/);
});

test('each criterion at 100% picks the model that is best on it', () => {
  // Compare values, not keys: two models can tie on a rounded criterion (e.g. the two cheapest).
  const top = (w: Weights) => cat.models.find((m) => m.key === rankModels(cat, w, 0)[0].key)!.benchmark;
  const all = cat.models.map((m) => m.benchmark);
  assert.equal(top({ quality: 100, cost: 0, latency: 0 }).quality, Math.max(...all.map((b) => b.quality)));
  assert.equal(top({ quality: 0, cost: 100, latency: 0 }).avgCostUsd, Math.min(...all.map((b) => b.avgCostUsd)));
  assert.equal(top({ quality: 0, cost: 0, latency: 100 }).avgLatencySec, Math.min(...all.map((b) => b.avgLatencySec)));
});

test('ranking is complete, ordered and scores stay within 0-100', () => {
  const r = rankModels(cat, { quality: 50, cost: 25, latency: 25 }, 70);
  assert.deepEqual(r.map((x) => x.rank), cat.models.map((_, i) => i + 1));
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].total >= r[i].total);
  for (const x of r) for (const v of [...Object.values(x.scores), x.total]) assert.ok(v >= 0 && v <= 100);
});

test('a model below the quality floor is ranked but does not set the scale for the others', () => {
  const weak = cat.models.filter((m) => m.benchmark.quality < 70);
  assert.ok(weak.length > 0, 'catalog keeps at least one below-floor model as a teaching example');
  const r = rankModels(cat, { quality: 100, cost: 0, latency: 0 }, 70);
  const eligible = r.filter((x) => x.eligible);
  assert.equal(Math.min(...eligible.map((x) => x.scores.quality)), 0); // the weakest eligible model anchors 0, not the outlier
  for (const w of weak) assert.equal(r.find((x) => x.key === w.key)!.scores.quality, 0);
});

test('decide: switches to the best eligible model, respects the margin and the quality floor', () => {
  const r = rankModels(cat, { quality: 0, cost: 100, latency: 0 }, 70);
  const d = decide(r, 'claude-sonnet-4-6', 1);
  assert.equal(d.switch, true);
  assert.equal(d.to, r[0].key);
  assert.equal(decide(r, r[0].key, 1).switch, false);
  // Floor above everyone except the top quality model: cost-first ranking still routes to an eligible model only.
  const top = [...cat.models].sort((a, b) => b.benchmark.quality - a.benchmark.quality)[0];
  const floored = rankModels(cat, { quality: 0, cost: 100, latency: 0 }, top.benchmark.quality);
  const d2 = decide(floored, 'claude-haiku-4-5', 1);
  assert.equal(cat.models.find((m) => m.key === d2.to)!.benchmark.quality, top.benchmark.quality); // several may tie at the top
  // A below-floor model can still rank #1 on mixed weights; it is reported and skipped.
  const mixed = rankModels(cat, { quality: 20, cost: 40, latency: 40 }, 70);
  assert.equal(mixed[0].eligible, false);
  const d3 = decide(mixed, 'claude-sonnet-4-6', 1);
  assert.equal(d3.to, mixed.find((x) => x.eligible)!.key);
  assert.match(d3.reason, /below the floor/);
  // A near-tie inside the margin keeps the current model.
  const r3 = rankModels(cat, { quality: 50, cost: 25, latency: 25 }, 0);
  assert.equal(decide(r3, r3[1].key, 1000).switch, false);
});

test('rebalance keeps integer weights that always sum to 100', () => {
  let w: Weights = { quality: 50, cost: 25, latency: 25 };
  for (const [c, v] of [['quality', 80], ['cost', 33], ['latency', 0], ['quality', 100], ['cost', 7], ['latency', 61], ['quality', 0]] as const) {
    w = rebalance(w, c, v);
    assert.equal(w[c], v);
    assert.equal(sum(w), 100);
    for (const x of Object.values(w)) assert.ok(Number.isInteger(x) && x >= 0);
  }
  assert.deepEqual(rebalance({ quality: 100, cost: 0, latency: 0 }, 'quality', 40), { quality: 40, cost: 30, latency: 30 });
});

test('costUsd prices cache reads and writes separately', () => {
  const p = { pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, source: '', fetchedAt: '' } };
  assert.equal(Number(costUsd(p, { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }).toFixed(4)), 22.05);
});
