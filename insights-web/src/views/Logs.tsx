/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, type FormEvent } from 'react';
import { get } from '../api';

const PRESETS = [
  { label: 'MCP tool calls', source: 'workbench-api', filter: '{ $.log_type = "mcp_tool_call" }' },
  { label: 'Approval decisions', source: 'workbench-api', filter: '{ $.log_type = "audit_decision" }' },
  { label: 'Analyses', source: 'workbench-api', filter: '{ $.log_type = "audit_analysis" }' },
  { label: 'Student sign-ups', source: 'workbench-signup', filter: '{ $.log_type = "self_signup" }' },
  { label: 'Inside MCP server 1', source: 'mcp-claims-policy', filter: 'mcp_tool_call' },
  { label: 'Errors', source: 'workbench-api', filter: '?error ?Error ?api_error' },
];

export function Logs() {
  const [sources, setSources] = useState<any[]>([]);
  const [source, setSource] = useState('workbench-api');
  const [filter, setFilter] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [data, setData] = useState<any>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    get<any>('/api/insights/logs/sources').then((r) => setSources(r.sources), (e) => setError(e.message));
  }, []);

  const search = (src = source, f = filter) => {
    setLoading(true);
    setError(undefined);
    const q = new URLSearchParams({ source: src, minutes: String(minutes), limit: '50', ...(f ? { filter: f } : {}) });
    get(`/api/insights/logs?${q}`).then(setData, (e) => setError(e.message)).finally(() => setLoading(false));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    search();
  };
  const current = sources.find((s) => s.id === source);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Logs explorer</h1>
          <p className="muted">Read-only access to the allow-listed CloudWatch log groups of both apps. Credentials and tokens are redacted.</p>
        </div>
      </div>
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.label} className="suggestion" onClick={() => { setSource(p.source); setFilter(p.filter); search(p.source, p.filter); }}>{p.label}</button>
        ))}
      </div>
      <form className="log-form card" onSubmit={submit}>
        <label>Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="grow">Filter (text or CloudWatch pattern)
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='e.g. CLM-24817 or { $.log_type = "llm_call" }' />
        </label>
        <label>Window
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            <option value={15}>15 min</option><option value={60}>1 hour</option><option value={1440}>24 hours</option><option value={10080}>7 days</option>
          </select>
        </label>
        <button className="primary" type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
        {current && <p className="muted small full"><code>{current.logGroup}</code>: {current.description}</p>}
      </form>
      {error && <div className="alert bad">{error}</div>}
      {data && (
        <section className="card">
          <div className="muted small">{data.matched} matching event(s), newest {data.events.length} shown</div>
          <ul className="events">
            {data.events.map((e: any, i: number) => (
              <li key={i}><span className="muted small">{new Date(e.ts).toLocaleString()}</span><pre>{typeof e.message === 'string' ? e.message : JSON.stringify(e.message, null, 2)}</pre></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
