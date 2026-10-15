/* eslint-disable @typescript-eslint/no-explicit-any */
// Costs, two lenses: (1) every LLM call priced from its logged token usage (near real time, exact per call);
// (2) AWS Cost Explorer: what AWS actually billed the account (by service and day, ~24 h behind).
import { useEffect, useState } from 'react';
import { get } from '../api';

const usd = (n: number | null | undefined, digits?: number) => {
  if (n == null) return '—';
  const d = digits ?? (n === 0 ? 2 : Math.abs(n) < 0.01 ? 5 : Math.abs(n) < 1 ? 4 : 2);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const APP_LABEL: Record<string, string> = { 'claims-workbench': 'Workbench agent', 'class-insights': 'Insights chatbot' };

export function Costs() {
  return (
    <div className="page costs">
      <div className="page-head">
        <div>
          <h1>Costs</h1>
          <p className="muted">
            Two views of the same spend. <strong>Per LLM call</strong> is computed from the token counts that Bedrock returns with every call
            (logged in the reasoning log) times the AWS list price, so it is exact per call and appears seconds later.{' '}
            <strong>AWS Cost Explorer</strong> is what AWS actually billed the account, by service and day, and lags by up to a day.
          </p>
        </div>
      </div>
      <LlmCalls />
      <CostExplorer />
    </div>
  );
}

function LlmCalls() {
  const [app, setApp] = useState('all');
  const [minutes, setMinutes] = useState(10080);
  const [data, setData] = useState<any>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [flat, setFlat] = useState(false);

  const load = () => {
    setLoading(true);
    setError(undefined);
    get(`/api/insights/costs/llm?app=${app}&minutes=${minutes}&limit=1000`).then(setData, (e) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [app, minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const callsByRun = new Map<string, any[]>();
  for (const c of data?.calls ?? []) callsByRun.set(`${c.app}|${c.runId}`, [...(callsByRun.get(`${c.app}|${c.runId}`) ?? []), c]);
  const maxModel = Math.max(0.000001, ...(data?.byModel ?? []).map((m: any) => m.costUsd));
  const chat = data?.byApp?.['class-insights'];
  const chatRuns = (data?.runs ?? []).filter((r: any) => r.app === 'class-insights').length;

  return (
    <section className="cost-section">
      <div className="section-head">
        <h2>1 · Every LLM call <span className="muted thin">from the reasoning logs (CloudWatch), near real time</span></h2>
        <div className="filters">
          <select value={app} onChange={(e) => setApp(e.target.value)} aria-label="Application">
            <option value="all">Both apps</option>
            <option value="claims-workbench">Claims Workbench agent</option>
            <option value="class-insights">Class Insights chatbot</option>
          </select>
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Time window">
            <option value={60}>Last hour</option>
            <option value={1440}>Last 24 hours</option>
            <option value={10080}>Last 7 days</option>
            <option value={20160}>Last 14 days</option>
          </select>
          <button className="ghost" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {!data && !error && <div className="empty"><span className="spinner" /> Reading llm_call lines from CloudWatch Logs…</div>}
      {data && (
        <>
          <div className="stats">
            <Stat n={usd(data.totals.costUsd, 4)} label="LLM spend in window" />
            <Stat n={data.totals.calls.toLocaleString()} label="model calls" />
            <Stat n={usd(data.analyses.avgCostUsd)} label={`per Workbench analysis (${data.analyses.count})`} />
            <Stat n={chatRuns ? usd(chat.costUsd / chatRuns) : '—'} label={`per chatbot answer (${chatRuns})`} />
            <Stat n={`${tok(data.totals.inputTokens)} / ${tok(data.totals.outputTokens)}`} label="tokens in / out" />
          </div>

          <div className="card">
            <h2>Spend by model</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Model</th><th>Share of spend</th><th className="num">Cost</th><th className="num">Calls</th><th className="num">Analyses</th><th className="num">$ / analysis</th><th className="num">Avg call</th></tr></thead>
                <tbody>
                  {data.byModel.map((m: any) => (
                    <tr key={m.model}>
                      <td><strong>{m.model}</strong></td>
                      <td><span className="hbar"><span style={{ width: `${(100 * m.costUsd) / maxModel}%` }} /></span></td>
                      <td className="num">{usd(m.costUsd, 4)}</td>
                      <td className="num">{m.calls}</td>
                      <td className="num">{m.analyses || '—'}</td>
                      <td className="num">{usd(m.avgCostPerAnalysisUsd)}</td>
                      <td className="num">{(m.avgLatencyMs / 1000).toFixed(1)} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Priced from {data.pricedFrom}. Prompt-cache reads and writes are priced at their own rates. Hover a cost to see whether it was logged at call time or computed later.</p>
          </div>

          <div className="card">
            <div className="card-row">
              <h2>Individual calls{data.callsTruncated ? ' (most recent 1,000)' : ''}</h2>
              <label className="toggle small"><input type="checkbox" checked={flat} onChange={(e) => setFlat(e.target.checked)} /> flat list</label>
            </div>
            {data.calls.length === 0 && <div className="empty">No LLM calls in this window. Run an analysis in the Workbench or ask the chatbot something.</div>}
            {flat ? (
              <CallTable calls={data.calls} showRun />
            ) : (
              data.runs.filter((r: any) => callsByRun.has(`${r.app}|${r.runId}`)).map((r: any, i: number) => (
                <details key={`${r.app}|${r.runId}`} className="run-cost" open={i < 3}>
                  <summary>
                    <span className={`app-badge ${r.app}`}>{APP_LABEL[r.app] ?? r.app}</span>
                    <span className="run-what">{r.claimId ? <strong>{r.claimId}</strong> : <span>Question</span>} <span className="muted small">{when(r.startedAt)} · {r.models.join(', ')}</span></span>
                    <span className="run-total"><strong>{usd(r.costUsd, 4)}</strong> <span className="muted small">{r.calls} call{r.calls === 1 ? '' : 's'}</span></span>
                  </summary>
                  <CallTable calls={[...callsByRun.get(`${r.app}|${r.runId}`)!].reverse()} />
                </details>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

function CallTable({ calls, showRun = false }: { calls: any[]; showRun?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="calls-table">
        <thead>
          <tr>
            <th>Time</th>
            {showRun && <th>App / run</th>}
            <th className="num">Turn</th><th>Model</th><th className="num">Input</th><th className="num">Cache read</th><th className="num">Output</th><th className="num">Latency</th><th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={`${c.runId}-${c.turn}-${c.ts}`}>
              <td className="nowrap">{when(c.ts)}</td>
              {showRun && <td><span className={`app-badge ${c.app}`}>{APP_LABEL[c.app] ?? c.app}</span> <span className="muted small">{c.claimId ?? c.runId.slice(-8)}</span></td>}
              <td className="num">{c.turn}</td>
              <td className="nowrap">{c.modelName}</td>
              <td className="num">{c.inputTokens.toLocaleString()}</td>
              <td className="num">{c.cacheReadTokens ? c.cacheReadTokens.toLocaleString() : '—'}</td>
              <td className="num">{c.outputTokens.toLocaleString()}</td>
              <td className="num">{(c.latencyMs / 1000).toFixed(1)} s</td>
              <td className="num" title={c.costSource}>{c.costSource.startsWith('no token usage') ? <span className="muted small">not recorded</span> : <strong>{usd(c.costUsd, 5)}</strong>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CostExplorer() {
  const [data, setData] = useState<any>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const load = (refresh = false) => {
    setLoading(true);
    setError(undefined);
    get(`/api/insights/costs/explorer${refresh ? '?refresh=1' : ''}`).then(setData, (e) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  const maxDay = Math.max(0.01, ...(data?.daily ?? []).map((d: any) => d.totalUsd));
  const maxSvc = Math.max(0.01, ...(data?.monthToDate?.byService ?? []).map((s: any) => s.usd));
  const isLlm = (s: string) => /bedrock|claude|llama|nova|gpt-oss|mistral|anthropic/i.test(s);

  return (
    <section className="cost-section">
      <div className="section-head">
        <h2>2 · AWS Cost Explorer <span className="muted thin">what AWS billed (whole account)</span></h2>
        <div className="filters">
          {data && <span className="muted small">{data.cached ? `cached ${new Date(data.cachedAt).toLocaleTimeString()}` : `fetched ${new Date(data.generatedAt).toLocaleTimeString()}`}</span>}
          <button className="ghost" onClick={() => load(true)} disabled={loading} title="Each refresh makes ~5 Cost Explorer API calls ($0.01 each)">{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {!data && !error && <div className="empty"><span className="spinner" /> Querying Cost Explorer…</div>}
      {data && (
        <>
          <div className="stats">
            <Stat n={usd(data.monthToDate.totalUsd, 2)} label={`month to date (since ${data.monthToDate.start})`} />
            <Stat n={usd(data.monthToDate.llmUsd, 2)} label="of which LLM / Bedrock" />
            <Stat n={data.forecastRestOfMonthUsd == null ? '—' : usd(data.forecastRestOfMonthUsd, 2)} label="forecast, rest of month" />
            <Stat n={usd(data.lastMonth.totalUsd, 2)} label={`last month (LLM ${usd(data.lastMonth.llmUsd, 2)})`} />
            <Stat n={usd(data.taggedThisApp.monthToDateUsd, 2)} label="tagged to this class app" />
          </div>

          <div className="two-col">
            <div className="card">
              <h2>Daily spend, last 14 days</h2>
              <div className="daily">
                {data.daily.map((d: any) => (
                  <div className="day" key={d.date} title={`${d.date}: ${usd(d.totalUsd, 2)} total, ${usd(d.llmUsd, 2)} LLM`}>
                    <div className="day-bar" style={{ height: `${(100 * d.totalUsd) / maxDay}%` }}>
                      <div className="day-llm" style={{ height: d.totalUsd ? `${(100 * d.llmUsd) / d.totalUsd}%` : 0 }} />
                    </div>
                    <span className="day-label">{d.date.slice(8)}</span>
                  </div>
                ))}
              </div>
              <div className="legend small"><span className="sw llm" /> LLM / Bedrock <span className="sw other" /> everything else</div>
            </div>
            <div className="card">
              <h2>Month to date by service</h2>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {data.monthToDate.byService.slice(0, 14).map((s: any) => (
                      <tr key={s.service} className={isLlm(s.service) ? 'llm-row' : ''}>
                        <td>{s.service}</td>
                        <td><span className="hbar"><span style={{ width: `${(100 * s.usd) / maxSvc}%` }} /></span></td>
                        <td className="num">{usd(s.usd, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {data.llmMonthToDateByUsageType.length > 0 && (
            <div className="card">
              <h2>LLM spend by usage type, month to date</h2>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Usage type (region, model, token kind)</th><th className="num">Cost</th></tr></thead>
                  <tbody>
                    {data.llmMonthToDateByUsageType.map((u: any) => <tr key={u.usageType}><td><code className="wrap">{u.usageType}</code></td><td className="num">{usd(u.usd, 3)}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card notes">
            <p className="small"><strong>Scope.</strong> {data.scope}</p>
            <p className="small"><strong>Freshness.</strong> {data.dataLag}</p>
            <p className="small"><strong>Tag {data.taggedThisApp.tag}.</strong> {data.taggedThisApp.note}</p>
            {data.errors.length > 0 && <p className="small muted">Some queries failed: {data.errors.join('; ')}</p>}
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="stat">
      <span className="stat-n">{n}</span>
      <span className="muted small">{label}</span>
    </div>
  );
}
