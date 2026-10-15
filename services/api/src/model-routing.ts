// Model routing: the candidate LLMs, the preference weights stored in AWS AppConfig, and the scoring that ranks them.
// Pure (no AWS SDK, no Node APIs) so the browser imports the same code for its live preview: what the slider preview
// shows is exactly what the Lambda computes when a student clicks "Evaluate & apply".

export type Criterion = 'quality' | 'cost' | 'latency';
export const CRITERIA: Criterion[] = ['quality', 'cost', 'latency'];

/** Percentages; integers 0-100 that always sum to 100. */
export type Weights = Record<Criterion, number>;

export interface ModelEntry {
  key: string;
  name: string;
  provider: string;
  /** Bedrock model id or cross-region inference profile id passed to Converse. */
  modelId: string;
  /** Foundation model ARN suffix used in IAM (the profile routes to this model in several us-* regions). */
  foundationModel: string;
  strengths: string;
  tradeoffs: string;
  invocation: {
    /** 'adaptive' = Claude extended thinking (reasoning is logged); 'off' = plain tool use at temperature 0. */
    reasoning: 'adaptive' | 'off';
    /** Bedrock prompt caching (cachePoint blocks) - only sent to models that support it. */
    promptCache: boolean;
    maxTokens: number;
  };
  /** USD per 1M tokens, from the AWS Price List API (us-east-1, on-demand, the profile's geo tier). */
  pricing: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number; source: string; fetchedAt: string };
  /** Measured by scripts/model_benchmark.py on the real Workbench task (all 8 claims, both MCP servers). */
  benchmark: {
    quality: number;
    avgLatencySec: number;
    avgCostUsd: number;
    runs: number;
    completedRuns: number;
    correctDispositions: number;
    measuredAt: string;
  };
}

export interface ModelCatalog {
  version: number;
  description: string;
  models: ModelEntry[];
}

/** The AppConfig "model-selection" profile: what students change. */
export interface ModelSelection {
  weights: Weights;
  activeModel: string;
  /** Models below this benchmark quality are ranked but never routed live traffic. */
  qualityFloor: number;
  /** The winner must beat the active model by at least this many points before we switch (no flapping on near-ties). */
  switchMargin: number;
  updatedBy: string;
  updatedAt: string;
  reason: string;
}

export const DEFAULT_WEIGHTS: Weights = { quality: 50, cost: 25, latency: 25 };

export interface RankedModel {
  rank: number;
  key: string;
  name: string;
  provider: string;
  modelId: string;
  /** 0-100 sub-scores, relative to the candidates that pass the quality floor: best = 100, worst = 0, others clamped (quality linear; cost and latency on a log scale). */
  scores: Record<Criterion, number>;
  total: number;
  eligible: boolean;
  /** Raw benchmark score (0-100 rubric); the quality floor applies to this. */
  benchmarkQuality: number;
  avgCostUsd: number;
  avgLatencySec: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

const clamp = (x: number) => Math.min(100, Math.max(0, x));

/** Linear min-max: 100 for the best benchmark quality, 0 for the worst (values outside the range are clamped). */
function linearScore(value: number, all: number[]): number {
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  return hi === lo ? 100 : clamp((100 * (value - lo)) / (hi - lo));
}

/** Log-scale min-max: 100 for the cheapest/fastest, 0 for the most expensive/slowest. A 2x difference counts the same anywhere. */
function inverseLogScore(value: number, all: number[]): number {
  const lo = Math.log(Math.min(...all));
  const hi = Math.log(Math.max(...all));
  return hi === lo ? 100 : clamp((100 * (hi - Math.log(value))) / (hi - lo));
}

export function validateWeights(w: unknown): Weights {
  const o = (w ?? {}) as Record<string, unknown>;
  const out = {} as Weights;
  for (const c of CRITERIA) {
    const v = o[c];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) throw new Error(`weights.${c} must be an integer from 0 to 100`);
    out[c] = v;
  }
  const sum = CRITERIA.reduce((s, c) => s + out[c], 0);
  if (sum !== 100) throw new Error(`weights must add up to 100 (got ${sum})`);
  return out;
}

export function rankModels(catalog: ModelCatalog, weights: Weights, qualityFloor: number): RankedModel[] {
  // Every criterion is scaled the same way (relative to the candidates), so a weight means the same thing on each slider.
  // Raw benchmark quality only spans a few points while cost spans ~40x; without this, quality would barely matter.
  // The scale is set by the models that pass the quality floor (the real choices); a model below the floor is still
  // ranked, with its sub-scores clamped to 0-100, so one weak outlier cannot squash the differences between the others.
  const eligible = catalog.models.filter((m) => m.benchmark.quality >= qualityFloor);
  const basis = eligible.length ? eligible : catalog.models;
  const costs = basis.map((m) => m.benchmark.avgCostUsd);
  const lats = basis.map((m) => m.benchmark.avgLatencySec);
  const quals = basis.map((m) => m.benchmark.quality);
  return catalog.models
    .map((m) => {
      const scores = {
        quality: round1(linearScore(m.benchmark.quality, quals)),
        cost: round1(inverseLogScore(m.benchmark.avgCostUsd, costs)),
        latency: round1(inverseLogScore(m.benchmark.avgLatencySec, lats)),
      };
      const total = round1(CRITERIA.reduce((s, c) => s + (weights[c] * scores[c]) / 100, 0));
      return {
        rank: 0, key: m.key, name: m.name, provider: m.provider, modelId: m.modelId, scores, total,
        eligible: m.benchmark.quality >= qualityFloor, benchmarkQuality: m.benchmark.quality, avgCostUsd: m.benchmark.avgCostUsd, avgLatencySec: m.benchmark.avgLatencySec,
      };
    })
    .sort((a, b) => b.total - a.total || Number(b.eligible) - Number(a.eligible) || b.scores.quality - a.scores.quality)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface Decision {
  switch: boolean;
  from: string;
  to: string;
  reason: string;
}

/** Should live traffic move? Only to an eligible model that beats the active one by the margin. */
export function decide(ranking: RankedModel[], activeKey: string, margin: number): Decision {
  const active = ranking.find((r) => r.key === activeKey);
  const best = ranking.find((r) => r.eligible);
  const top = ranking[0];
  if (!best) return { switch: false, from: activeKey, to: activeKey, reason: 'No candidate meets the quality floor; keeping the current model.' };
  const skipped = top.eligible ? '' : `${top.name} ranks #1 but its benchmark quality (${top.benchmarkQuality}) is below the floor, so it cannot serve live traffic. `;
  if (best.key === activeKey) return { switch: false, from: activeKey, to: activeKey, reason: `${skipped}${best.name} is already the best eligible model (${best.total} points).` };
  if (!active || !active.eligible) {
    return { switch: true, from: activeKey, to: best.key, reason: `${skipped}Switching to ${best.name} (${best.total} points); the current model is not an eligible candidate.` };
  }
  const gap = round1(best.total - active.total);
  if (gap < margin) {
    return { switch: false, from: activeKey, to: activeKey, reason: `${skipped}${best.name} leads by only ${gap} points (switch margin ${margin}); keeping ${active.name} to avoid flapping on a near-tie.` };
  }
  return { switch: true, from: activeKey, to: best.key, reason: `${skipped}${best.name} scores ${best.total} vs ${active.total} for ${active.name} (+${gap}); switching live traffic.` };
}

/** Estimated cost of one call/run from Bedrock usage (uncached input, cache reads/writes, output). */
export function costUsd(m: Pick<ModelEntry, 'pricing'>, u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
  const p = m.pricing;
  return (
    (u.inputTokens * p.inputPerMTok + u.outputTokens * p.outputPerMTok + (u.cacheReadTokens ?? 0) * (p.cacheReadPerMTok ?? p.inputPerMTok) +
      (u.cacheWriteTokens ?? 0) * (p.cacheWritePerMTok ?? p.inputPerMTok)) / 1e6
  );
}

/** Rebalance the other two weights proportionally so all three still sum to 100 (used by the sliders). */
export function rebalance(w: Weights, changed: Criterion, value: number): Weights {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const others = CRITERIA.filter((c) => c !== changed);
  const rest = 100 - v;
  const otherSum = others.reduce((s, c) => s + w[c], 0);
  const raw = others.map((c) => (otherSum === 0 ? rest / others.length : (w[c] * rest) / otherSum));
  const floor = raw.map(Math.floor);
  let left = rest - floor.reduce((a, b) => a + b, 0);
  // Largest remainder gets the leftover points, so the result is integers that add to exactly 100.
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) if (left-- > 0) floor[i]++;
  const out = { ...w, [changed]: v } as Weights;
  others.forEach((c, i) => (out[c] = floor[i]));
  return out;
}
