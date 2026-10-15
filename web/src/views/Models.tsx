// Model routing: students set quality/cost/latency preferences (stored in AWS AppConfig) and the app routes the Bedrock
// agent to the best of the candidate LLMs in the AppConfig catalog. The preview uses the same scoring code as the Lambda.
import { useEffect, useRef, useState } from 'react';
import {
  CRITERIA,
  rankModels,
  rebalance,
  type Criterion,
  type Decision,
  type ModelCatalog,
  type ModelSelection,
  type RankedModel,
  type Weights,
} from '../../../services/api/src/model-routing';
import { api } from '../api';
import { Badge, Card, Spinner } from '../components/ui';

interface ModelsView {
  source: string;
  selection: ModelSelection;
  catalog: ModelCatalog;
  ranking: RankedModel[];
  history: { deploymentNumber?: number; version?: string; state?: string; startedAt?: string; completedAt?: string; description?: string }[];
}
interface EvaluateResult {
  decision: Decision;
  summary: string;
  unchanged: boolean;
  deployment: { version: number; deploymentNumber: number; durationMs: number } | null;
  selection: ModelSelection;
  ranking: RankedModel[];
}

const LABEL: Record<Criterion, string> = { quality: 'Quality', cost: 'Cost', latency: 'Latency' };
const HINT: Record<Criterion, string> = {
  quality: 'Benchmark score on the real task',
  cost: 'Lower $ per analysis is better',
  latency: 'Faster analysis is better',
};
const PRESETS: { label: string; w: Weights }[] = [
  { label: 'Default 50/25/25', w: { quality: 50, cost: 25, latency: 25 } },
  { label: 'Quality first', w: { quality: 100, cost: 0, latency: 0 } },
  { label: 'Cheapest', w: { quality: 0, cost: 100, latency: 0 } },
  { label: 'Fastest', w: { quality: 0, cost: 0, latency: 100 } },
];
const same = (a: Weights, b: Weights) => CRITERIA.every((c) => a[c] === b[c]);
const usd4 = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;
const ago = (iso?: string) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleString();
};

export function Models({ onModelChange }: { onModelChange?: () => void }) {
  const [view, setView] = useState<ModelsView>();
  const [weights, setWeights] = useState<Weights>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EvaluateResult>();
  const [error, setError] = useState<string>();
  const touched = useRef(false); // once a student moves a slider, background refreshes must not overwrite it

  const load = async () => {
    const v = await api.get<ModelsView>('/api/models');
    setView(v);
    if (!touched.current) setWeights(v.selection.weights);
  };

  useEffect(() => {
    load().catch((e) => setError(e.message));
    // Another student may change the configuration at any time: refresh the live state every 15 s (the AppConfig poll interval).
    const t = setInterval(() => {
      load().catch(() => {});
    }, 15_000);
    return () => {
      clearInterval(t);
    };
  }, []);

  if (error && !view) return <div className="alert bad">{error}</div>;
  if (!view || !weights) return <div className="center-block"><Spinner /></div>;

  const { selection, catalog } = view;
  const configured = selection.weights;
  const dirty = !same(weights, configured);
  const preview = rankModels(catalog, weights, selection.qualityFloor);
  const liveRank = Object.fromEntries(view.ranking.map((r) => [r.key, r.rank]));
  const active = catalog.models.find((m) => m.key === selection.activeModel);
  const liveTop = view.ranking.find((r) => r.eligible);

  const set = (c: Criterion, v: number) => {
    touched.current = true;
    setResult(undefined);
    setWeights(rebalance(weights, c, v));
  };

  const apply = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<EvaluateResult>('/api/models/evaluate', { weights });
      setResult(r);
      touched.current = false;
      await load();
      onModelChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="models">
      <div className="page-head">
        <div>
          <h1>Model routing</h1>
          <p className="muted">
            Amazon Bedrock exposes every model through the same Converse API, so this app can switch LLMs without a code change or a
            redeploy. Set what matters to you; the app ranks {catalog.models.length} candidate LLMs and, when warranted, routes live analyses to a different one.
          </p>
        </div>
      </div>

      <div className="models-grid">
        <Card title="Live configuration" aside={<Badge tone="info">AWS AppConfig</Badge>}>
          <div className="live-model">
            <span className="muted small">Analyses currently run on</span>
            <strong className="live-model-name">{active?.name ?? selection.activeModel}</strong>
            <span className="muted small">{active?.provider} · <code className="wrap">{active?.modelId}</code></span>
          </div>
          <div className="weights-pills">
            {CRITERIA.map((c) => (
              <span key={c} className="pill"><span className="muted">{LABEL[c]}</span> <strong>{configured[c]}%</strong></span>
            ))}
          </div>
          <p className="small muted">
            Set by <strong>{selection.updatedBy}</strong> {ago(selection.updatedAt)}. {selection.reason}
          </p>
          {liveTop && liveTop.key !== selection.activeModel && (
            <div className="alert info small">
              Under these preferences <strong>{liveTop.name}</strong> ranks first. Click <em>Evaluate &amp; apply</em> to re-evaluate.
            </div>
          )}
          <p className="small muted">
            Stored as the <code>model-selection</code> profile of application <code>claims-workbench</code>, environment <code>live</code>.
            Every Lambda instance re-reads it within 15 s.
          </p>
        </Card>

        <Card title="Your preferences" aside={<span className={`sum ${dirty ? 'dirty' : ''}`}>Total {CRITERIA.reduce((s, c) => s + weights[c], 0)}%</span>}>
          {CRITERIA.map((c) => (
            <div className="slider-row" key={c}>
              <label htmlFor={`w-${c}`}>
                <span>{LABEL[c]} <span className="muted small">{HINT[c]}</span></span>
                <strong className="num">{weights[c]}%</strong>
              </label>
              <input id={`w-${c}`} type="range" min={0} max={100} step={1} value={weights[c]} aria-label={`${LABEL[c]} weight`}
                onChange={(e) => set(c, Number(e.target.value))} className={`slider ${c}`} />
            </div>
          ))}
          <p className="small muted">Moving one slider rebalances the other two, so the weights always add up to 100%.</p>
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p.label} className="ghost small-btn" onClick={() => { touched.current = true; setResult(undefined); setWeights(p.w); }}>{p.label}</button>
            ))}
            {dirty && <button className="link small" onClick={() => { touched.current = false; setWeights(configured); }}>Reset to live</button>}
          </div>
          <button className="primary wide apply" onClick={apply} disabled={busy}>
            {busy ? <><Spinner /> Evaluating and deploying to AppConfig…</> : 'Evaluate & apply'}
          </button>
          {error && <div className="alert bad small">{error}</div>}
          {result && (
            <div className={`alert ${result.decision.switch ? 'good' : 'info'} small result`}>
              <strong>{result.decision.switch ? 'Switched: ' : 'No switch: '}</strong>{result.decision.reason}
              <div className="muted">
                {result.unchanged
                  ? 'Preferences unchanged, so nothing was deployed.'
                  : `AppConfig version ${result.deployment?.version}, deployment #${result.deployment?.deploymentNumber}, live in ${((result.deployment?.durationMs ?? 0) / 1000).toFixed(1)} s.`}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card
        title={dirty ? 'Ranking preview (your sliders, not applied yet)' : 'Ranking under the live preferences'}
        aside={dirty ? <Badge tone="warn">Preview</Badge> : <Badge tone="good">Live</Badge>}
      >
        <div className="table-wrap">
          <table className="ranking">
            <thead>
              <tr>
                <th>#</th>
                <th>Model</th>
                {CRITERIA.map((c) => <th key={c}>{LABEL[c]} <span className="muted thin">×{weights[c]}%</span></th>)}
                <th>Score</th>
                <th className="num">$ / analysis</th>
                <th className="num">Time</th>
                {dirty && <th className="num">Live #</th>}
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.key} className={r.key === selection.activeModel ? 'is-active' : ''}>
                  <td className="rank">{r.rank}</td>
                  <td>
                    <div className="model-cell">
                      <strong>{r.name}</strong>
                      <span className="muted small">{r.provider}</span>
                      {r.key === selection.activeModel && <Badge tone="good">serving live</Badge>}
                      {!r.eligible && <Badge tone="bad">below quality floor</Badge>}
                    </div>
                  </td>
                  {CRITERIA.map((c) => (
                    <td key={c} className="score-cell">
                      <span className="bar"><span className={`bar-fill ${c}`} style={{ width: `${r.scores[c]}%` }} /></span>
                      <span className="num small">{Math.round(r.scores[c])}</span>
                    </td>
                  ))}
                  <td className="total"><strong>{r.total.toFixed(1)}</strong></td>
                  <td className="num">{usd4(r.avgCostUsd)}</td>
                  <td className="num">{r.avgLatencySec.toFixed(0)} s</td>
                  {dirty && <td className="num">{liveRank[r.key]}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Score = Σ weight × sub-score. Sub-scores are relative to the models that pass the quality floor: the best of them on a criterion gets 100, the worst 0, and a model below the floor is clamped to that range
          (cost and latency on a log scale, so 2× cheaper counts the same anywhere). Switching needs a lead of at least {selection.switchMargin} point
          over the live model, and a model must score at least {selection.qualityFloor} on the benchmark to serve live traffic.
        </p>
      </Card>

      <Card title={`The ${catalog.models.length} candidates`} aside={<span className="muted small">benchmarked {new Date(catalog.models[0]?.benchmark.measuredAt).toLocaleDateString()}</span>}>
        <div className="candidates">
          {catalog.models.map((m) => (
            <div className="candidate" key={m.key}>
              <div className="candidate-head">
                <strong>{m.name}</strong>
                <span className="muted small">{m.provider}</span>
              </div>
              <p className="small">{m.strengths}</p>
              <p className="small muted">Trade-off: {m.tradeoffs}</p>
              <dl className="facts small">
                <dt>Benchmark</dt><dd>{m.benchmark.quality}/100 · {m.benchmark.correctDispositions}/{m.benchmark.runs} correct dispositions</dd>
                <dt>Per analysis</dt><dd>{usd4(m.benchmark.avgCostUsd)} · {m.benchmark.avgLatencySec} s</dd>
                <dt>List price</dt><dd>${m.pricing.inputPerMTok} in / ${m.pricing.outputPerMTok} out per 1M tokens</dd>
                <dt>Invocation</dt><dd>{m.invocation.reasoning === 'adaptive' ? 'adaptive thinking' : 'no extended thinking'}{m.invocation.promptCache ? ' · prompt caching' : ''}</dd>
                <dt>Bedrock id</dt><dd><code className="wrap">{m.modelId}</code></dd>
              </dl>
            </div>
          ))}
        </div>
        <p className="small muted">{catalog.description}</p>
      </Card>

      <Card title="Recent changes" aside={<span className="muted small">AppConfig deployment history</span>}>
        {view.history.length === 0 ? (
          <p className="muted small">No changes yet.</p>
        ) : (
          <ul className="history">
            {view.history.map((h) => (
              <li key={h.deploymentNumber}>
                <span className="muted small">#{h.deploymentNumber} · v{h.version} · {ago(h.startedAt)} · {h.state}</span>
                <span className="small">{h.description}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
