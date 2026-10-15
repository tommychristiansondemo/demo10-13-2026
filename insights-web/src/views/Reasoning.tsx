/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';
import { get } from '../api';

export function Reasoning() {
  const [app, setApp] = useState('all');
  const [minutes, setMinutes] = useState(1440);
  const [data, setData] = useState<any>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError(undefined);
    get(`/api/insights/reasoning?app=${app}&minutes=${minutes}&limit=15`).then(setData, (e) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [app, minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>LLM reasoning logs</h1>
          <p className="muted">
            Every model call made by the Claims Workbench agent and by this chatbot, from CloudWatch Logs: the prompt, the model's extended-thinking
            reasoning, its text output and the tools it called.
          </p>
        </div>
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
          </select>
          <button className="ghost" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {data && data.runs.length === 0 && <div className="empty">No LLM calls in this window yet. Run an analysis in the Workbench or ask the chatbot a question.</div>}
      {data?.runs.map((r: any) => (
        <section key={r.id} className="card run">
          <div className="run-head">
            <span className={`app-badge ${r.app}`}>{r.app === 'class-insights' ? 'Class Insights chatbot' : 'Claims Workbench agent'}</span>
            <code>{r.id}</code>
            {r.prompt?.claimId && <span>{r.prompt.claimId}</span>}
            <span className="muted small">{r.startedAt ? new Date(r.startedAt).toLocaleString() : ''} · {r.calls.length} model call(s) · {r.prompt?.modelName ?? r.prompt?.modelId ?? r.calls[0]?.modelId}{r.calls.some((c: any) => typeof c.costUsd === 'number') ? ` · $${r.calls.reduce((s: number, c: any) => s + (c.costUsd ?? 0), 0).toFixed(4)}` : ''}</span>
          </div>
          {r.prompt && (
            <details className="prompt">
              <summary>Prompt: {r.prompt.userMessage ? <i>“{String(r.prompt.userMessage).slice(0, 140)}”</i> : 'system prompt and tools'}</summary>
              <div className="muted small">Tools: {(r.prompt.tools ?? []).join(', ')}</div>
              {r.prompt.knowledge && <div className="muted small">Knowledge: {r.prompt.knowledge.s3} ({r.prompt.knowledge.chars} chars, sha256 {r.prompt.knowledge.sha256}) {r.prompt.knowledge.note}</div>}
              <pre>{r.prompt.systemPrompt}</pre>
            </details>
          )}
          <ol className="calls">
            {r.calls.map((c: any) => (
              <li key={`${c.turn}-${c.ts}`}>
                <div className="call-head">Turn {c.turn} · {c.stopReason} · {(c.latencyMs / 1000).toFixed(1)} s · {c.usage?.inputTokens ?? 0} in / {c.usage?.outputTokens ?? 0} out tokens{c.modelName ? ` · ${c.modelName}` : ''}{typeof c.costUsd === 'number' ? ` · $${c.costUsd.toFixed(5)}` : ''}</div>
                <Block label="Input" items={(c.input ?? []).map((x: any) => (x.text ? x.text : x.toolResult ? `tool result ${x.toolResult}: ${x.content}` : JSON.stringify(x)))} />
                <Block label="Reasoning" items={c.reasoning ?? []} tone="reason" />
                <Block label="Output" items={c.outputText ?? []} />
                <Block label="Tool calls" items={(c.toolCalls ?? []).map((t: any) => `${t.name}(${t.input})`)} />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Block({ label, items, tone = '' }: { label: string; items: string[]; tone?: string }) {
  if (!items.length) return null;
  return (
    <div className={`block ${tone}`}>
      <div className="block-label">{label}</div>
      {items.map((t, i) => <pre key={i}>{t}</pre>)}
    </div>
  );
}
