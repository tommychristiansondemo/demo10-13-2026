import { useCallback, useEffect, useRef, useState } from 'react';
import type { EvidenceItem, Recommendation, RunRecord, RunValidation, StreamEvent } from '../../../services/api/src/events';
import { api, hasRecording, replayRecorded } from '../api';
import { Badge, Json, ServerChip, Spinner } from '../components/ui';
import { DISPOSITION_LABEL, dispositionTone, humanize, ms, usd } from '../format';
import type { Me } from '../App';

type TraceItem =
  | { kind: 'text'; text: string }
  | { kind: 'turn'; turn: number; latencyMs: number; inputTokens: number; outputTokens: number }
  | { kind: 'discover'; server: string; tools: string[]; latencyMs: number }
  | { kind: 'tool'; evidenceId: string; server: string; tool: string; args: Record<string, unknown>; result?: EvidenceItem };

interface RunSummary {
  runId: string;
  createdAt: string;
  requestedBy: string;
  status: string;
  disposition?: string;
  headline?: string;
}

export function AnalysisPanel({ claimId, me }: { claimId: string; me: Me }) {
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [rec, setRec] = useState<Recommendation>();
  const [validation, setValidation] = useState<RunValidation>();
  const [run, setRun] = useState<RunRecord>();
  const [running, setRunning] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [focus, setFocus] = useState<string>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [recording, setRecording] = useState(false);
  const [modelId, setModelId] = useState<string>();
  const abort = useRef<AbortController>(null);
  // Set once the user starts a live analysis or a replay, so the late-arriving "latest saved run" never overwrites it.
  const userStarted = useRef(false);

  const reset = () => {
    setTrace([]);
    setRec(undefined);
    setValidation(undefined);
    setRun(undefined);
    setError(undefined);
    setFocus(undefined);
  };

  const loadRuns = useCallback(async () => {
    const r = await api.get<{ runs: RunSummary[] }>(`/api/claims/${claimId}/runs`);
    setRuns(r.runs);
    return r.runs;
  }, [claimId]);

  const showRun = useCallback((r: RunRecord) => {
    reset();
    setRun(r);
    setRec(r.recommendation);
    setValidation(r.validation);
    setModelId(r.modelName ? `${r.modelName} (${r.modelId})` : r.modelId);
    setError(r.error);
    setTrace(r.evidence.map((e) => ({ kind: 'tool', evidenceId: e.id, server: e.server, tool: e.tool, args: e.args, result: e })));
  }, []);

  useEffect(() => {
    reset();
    setRuns([]);
    userStarted.current = false;
    hasRecording(claimId).then(setRecording);
    loadRuns()
      .then(async (list) => {
        if (!list[0] || userStarted.current) return;
        const latest = await api.get<RunRecord>(`/api/claims/${claimId}/runs/${list[0].runId}`);
        if (!userStarted.current) showRun(latest);
      })
      .catch(() => undefined);
    return () => abort.current?.abort();
  }, [claimId, loadRuns, showRun]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  const onEvent = (e: StreamEvent) => {
    switch (e.type) {
      case 'run_started':
        setModelId(e.modelName ? `${e.modelName} (${e.modelId})` : e.modelId);
        break;
      case 'tools_discovered':
        setTrace((t) => [...t, { kind: 'discover', server: e.server, tools: e.tools, latencyMs: e.latencyMs }]);
        break;
      case 'model_text':
        setTrace((t) => [...t, { kind: 'text', text: e.text }]);
        break;
      case 'model_turn':
        setTrace((t) => [...t, { kind: 'turn', turn: e.turn, latencyMs: e.latencyMs, inputTokens: e.inputTokens, outputTokens: e.outputTokens }]);
        break;
      case 'tool_call':
        setTrace((t) => [...t, { kind: 'tool', evidenceId: e.evidenceId, server: e.server, tool: e.tool, args: e.args }]);
        break;
      case 'tool_result':
        setTrace((t) => t.map((x) => (x.kind === 'tool' && x.evidenceId === e.evidence.id ? { ...x, result: e.evidence } : x)));
        break;
      case 'recommendation':
        setRec(e.recommendation);
        setValidation(e.validation);
        break;
      case 'run_completed':
        setRun(e.run);
        setError(e.run.error);
        break;
      case 'error':
        setError(e.message);
        break;
    }
  };

  const analyze = async () => {
    userStarted.current = true;
    reset();
    setRunning(true);
    setReplaying(false);
    setStarted(Date.now());
    abort.current = new AbortController();
    try {
      await api.stream(`/api/claims/${claimId}/analyze`, onEvent, abort.current.signal);
      await loadRuns();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const replay = async () => {
    userStarted.current = true;
    reset();
    setRunning(true);
    setReplaying(true);
    setStarted(Date.now());
    abort.current = new AbortController();
    try {
      await replayRecorded(claimId, onEvent, abort.current.signal);
    } finally {
      setRunning(false);
    }
  };

  const evidence = new Map(trace.filter((t): t is Extract<TraceItem, { kind: 'tool' }> => t.kind === 'tool' && !!t.result).map((t) => [t.evidenceId, t.result!]));
  const cite = (ids: string[] = []) => (
    <span className="cites">
      {ids.map((id) => (
        <button key={id} className={`cite ${evidence.get(id)?.server ?? ''}`} onClick={() => setFocus(id)} title={evidence.get(id) ? `${evidence.get(id)!.serverLabel}: ${evidence.get(id)!.tool}` : id}>
          {id}
        </button>
      ))}
    </span>
  );

  return (
    <aside className="analysis">
      <div className="analysis-head">
        <div>
          <h2>AI recommendation</h2>
          <p className="muted small">Amazon Bedrock agent · tools from 2 MCP servers on AgentCore Runtime{modelId && <> · <code>{modelId}</code></>}</p>
        </div>
        <div className="analysis-actions">
          {me.isAnalyst ? (
            <button className="primary" onClick={analyze} disabled={running}>
              {running && !replaying ? <><Spinner /> Analyzing… {started && ms(now - started)}</> : rec ? 'Re-run analysis' : 'Run AI analysis'}
            </button>
          ) : (
            <span className="muted small">Analysts can request an analysis</span>
          )}
          {recording && (
            <button className="ghost" onClick={replay} disabled={running} title="Replay a recorded run from a previous live session (demo fallback)">
              Replay recorded run
            </button>
          )}
        </div>
      </div>

      {runs.length > 1 && (
        <div className="history">
          <label className="muted small" htmlFor="run-select">History</label>
          <select
            id="run-select"
            value={run?.runId ?? ''}
            onChange={async (e) => showRun(await api.get<RunRecord>(`/api/claims/${claimId}/runs/${e.target.value}`))}
            disabled={running}
          >
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {new Date(r.createdAt).toLocaleString()} · {r.requestedBy} · {humanize(r.status.toLowerCase())}
              </option>
            ))}
          </select>
        </div>
      )}

      {replaying && <div className="alert info small">Replaying a recorded run. Nothing is being called live; approval is disabled.</div>}
      {error && <div className="alert bad">{error}</div>}

      {!rec && !running && trace.length === 0 && !error && (
        <div className="empty">
          <p>
            The agent discovers the tools exposed by both MCP servers, gathers evidence about this claim, reconciles the shop estimate against the damage
            assessment and submits a cited next-action plan for supervisor approval.
          </p>
        </div>
      )}

      {rec && (
        <RecommendationView rec={rec} validation={validation} run={run} cite={cite} me={me} replaying={replaying} onDecided={(r) => { setRun(r); loadRuns(); }} />
      )}

      {trace.length > 0 && (
        <div className="trace">
          <h4>
            Agent trace <span className="muted small">· {evidence.size} evidence items{run && <> · {ms(run.durationMs)} · {run.usage.inputTokens.toLocaleString()} in / {run.usage.outputTokens.toLocaleString()} out tokens{run.costUsd != null && <> · ≈ ${run.costUsd.toFixed(4)}</>}</>}</span>
          </h4>
          <ol>
            {trace.map((t, i) => (
              <TraceRow key={i} item={t} focused={t.kind === 'tool' && t.evidenceId === focus} />
            ))}
            {running && (
              <li className="trace-pending">
                <Spinner /> {replaying ? 'Replaying…' : 'Working…'}
              </li>
            )}
          </ol>
        </div>
      )}
    </aside>
  );
}

function TraceRow({ item, focused }: { item: TraceItem; focused: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (focused) {
      setOpen(true);
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focused]);

  if (item.kind === 'text') return <li className="trace-text">💬 {item.text}</li>;
  if (item.kind === 'turn')
    return (
      <li className="trace-turn">
        Model turn {item.turn} · {ms(item.latencyMs)} · {item.inputTokens.toLocaleString()} in / {item.outputTokens.toLocaleString()} out
      </li>
    );
  if (item.kind === 'discover')
    return (
      <li className="trace-discover">
        <ServerChip server={item.server} /> <code>tools/list</code> → {item.tools.length} tools <span className="muted">({ms(item.latencyMs)})</span>
      </li>
    );
  const r = item.result;
  const args = Object.entries(item.args)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : JSON.stringify(v)}`)
    .join(', ');
  return (
    <li ref={ref} className={`trace-tool ${focused ? 'focused' : ''} ${r && !r.ok ? 'failed' : ''}`}>
      <button className="trace-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`eid ${item.server}`}>{item.evidenceId}</span>
        <ServerChip server={item.server} />
        <code className="tool-name">{item.tool}</code>
        <span className="args">({args})</span>
        <span className="trace-status">{!r ? <Spinner /> : r.ok ? `✓ ${ms(r.latencyMs)}` : `✗ ${ms(r.latencyMs)}`}</span>
      </button>
      {open && r && <Json value={r.result} collapsed={false} label="tools/call result" />}
    </li>
  );
}

function RecommendationView({
  rec,
  validation,
  run,
  cite,
  me,
  replaying,
  onDecided,
}: {
  rec: Recommendation;
  validation?: RunValidation;
  run?: RunRecord;
  cite: (ids?: string[]) => React.ReactNode;
  me: Me;
  replaying: boolean;
  onDecided: (r: RunRecord) => void;
}) {
  const er = rec.estimate_review;
  return (
    <div className="rec">
      <div className={`rec-banner ${dispositionTone(rec.disposition)}`}>
        <div className="rec-disposition">{DISPOSITION_LABEL[rec.disposition] ?? rec.disposition}</div>
        {rec.additional_dispositions?.length ? <div className="rec-also">also: {rec.additional_dispositions.map((d) => DISPOSITION_LABEL[d] ?? d).join(' · ')}</div> : null}
        <p className="rec-headline">{rec.headline}</p>
        <div className="rec-meta">
          <Badge tone={rec.confidence === 'HIGH' ? 'good' : rec.confidence === 'MEDIUM' ? 'warn' : 'bad'}>{rec.confidence} confidence</Badge>
          <span className="small">{rec.confidence_rationale}</span>
        </div>
      </div>

      <section className="rec-section">
        <h4>Incident</h4>
        <p>{rec.incident_summary}</p>
      </section>
      <section className="rec-section">
        <h4>Coverage {cite(rec.coverage_position.evidence)}</h4>
        <p>
          <strong>{rec.coverage_position.verdict}.</strong> {rec.coverage_position.explanation}
        </p>
      </section>
      <section className="rec-section">
        <h4>Damage {cite(rec.damage_position.evidence)}</h4>
        <p>{rec.damage_position.summary}</p>
      </section>
      <section className="rec-section">
        <h4>Estimate review {cite(er.evidence)}</h4>
        <div className="kpis">
          <div><span className="muted small">Shop estimate</span><b>{usd(er.shop_estimate_total)}</b></div>
          <div><span className="muted small">Unsupported</span><b className="neg">−{usd(er.unsupported_amount)}</b></div>
          <div><span className="muted small">Missing ops</span><b className="pos">+{usd(er.missing_operations_amount)}</b></div>
          <div><span className="muted small">Net (pre-tax)</span><b>{er.net_adjustment >= 0 ? '+' : '−'}{usd(Math.abs(er.net_adjustment))}</b></div>
        </div>
        <p>{er.summary}</p>
      </section>

      <section className="rec-section">
        <h4>Recommended next actions</h4>
        <ol className="actions">
          {rec.next_actions.map((a, i) => (
            <li key={i}>
              <div className="action-head">
                <Badge tone={a.priority === 'HIGH' ? 'bad' : a.priority === 'MEDIUM' ? 'warn' : 'neutral'}>{a.priority}</Badge>
                <span className="owner">{humanize(a.owner.toLowerCase())}</span>
                {cite(a.evidence)}
              </div>
              <div className="action-text">{a.action}</div>
              <div className="muted small">{a.rationale}</div>
            </li>
          ))}
        </ol>
      </section>

      {rec.risk_flags.length > 0 && (
        <section className="rec-section">
          <h4>Risk flags</h4>
          <ul className="flags">
            {rec.risk_flags.map((f, i) => (
              <li key={i}>
                <Badge tone={f.severity === 'HIGH' ? 'bad' : f.severity === 'MEDIUM' ? 'warn' : 'neutral'}>{f.severity}</Badge> {f.flag} {cite(f.evidence)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rec.open_questions.length > 0 && (
        <section className="rec-section">
          <h4>Open questions</h4>
          <ul>{rec.open_questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </section>
      )}

      {validation && (
        <section className="rec-section grounding">
          <h4>Grounding checks</h4>
          <div className="tags">
            {validation.serversUsed.map((s) => <ServerChip key={s} server={s} />)}
            <Badge tone="info">{validation.toolCalls} tool calls</Badge>
            {validation.warnings.length === 0 ? <Badge tone="good">All citations valid</Badge> : validation.warnings.map((w) => <Badge key={w} tone="warn">{w}</Badge>)}
          </div>
        </section>
      )}

      {run && !replaying && <Approval run={run} me={me} onDecided={onDecided} />}
    </div>
  );
}

function Approval({ run, me, onDecided }: { run: RunRecord; me: Me; onDecided: (r: RunRecord) => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const decide = async (decision: 'APPROVED' | 'REJECTED' | 'RETURNED') => {
    setBusy(true);
    setError(undefined);
    try {
      onDecided(await api.post<RunRecord>(`/api/claims/${run.claimId}/runs/${run.runId}/decision`, { decision, comment }));
      setComment('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (run.status !== 'PENDING_APPROVAL') {
    return (
      <section className={`approval decided ${run.status.toLowerCase()}`}>
        <Badge tone={run.status === 'APPROVED' ? 'good' : run.status === 'FAILED' ? 'bad' : 'warn'}>{run.status.replace('_', ' ')}</Badge>
        {run.decision && (
          <span className="small">
            by <b>{run.decision.by}</b> at {new Date(run.decision.at).toLocaleString()}
            {run.decision.comment && <> — “{run.decision.comment}”</>}
          </span>
        )}
      </section>
    );
  }
  return (
    <section className="approval">
      <div className="approval-head">
        <Badge tone="warn">Pending supervisor approval</Badge>
        <span className="muted small">requested by {run.requestedBy}</span>
      </div>
      {me.isSupervisor ? (
        <>
          <textarea placeholder="Comment (required to reject or return)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={2} />
          <div className="approval-buttons">
            <button className="good" disabled={busy} onClick={() => decide('APPROVED')}>Approve plan</button>
            <button className="ghost" disabled={busy || !comment.trim()} onClick={() => decide('RETURNED')}>Return to analyst</button>
            <button className="bad" disabled={busy || !comment.trim()} onClick={() => decide('REJECTED')}>Reject</button>
          </div>
        </>
      ) : (
        <p className="muted small">Only members of claims-supervisors can approve. Sign in as a supervisor to decide.</p>
      )}
      {error && <div className="alert bad small">{error}</div>}
    </section>
  );
}
