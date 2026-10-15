import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Json, ServerChip, Spinner } from '../components/ui';
import { ms } from '../format';

interface ServerInfo {
  id: string;
  label: string;
  runtimeArn: string | null;
  endpoint?: string;
  transport?: string;
  auth?: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  tools: { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[];
}

export function McpServers() {
  const [data, setData] = useState<{ region: string; servers: ServerInfo[] }>();
  const [error, setError] = useState<string>();
  const load = () => {
    setData(undefined);
    setError(undefined);
    api.get<{ region: string; servers: ServerInfo[] }>('/api/mcp/servers').then(setData, (e) => setError(e.message));
  };
  useEffect(load, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>MCP servers</h1>
          <p className="muted">
            Live <code>initialize</code> + <code>tools/list</code> against each independently deployed Amazon Bedrock AgentCore Runtime, made by the API
            Lambda with its IAM role (SigV4). The browser never talks to the runtimes.
          </p>
        </div>
        <button className="ghost" onClick={load}>Refresh</button>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {!data && !error && <div className="loading"><Spinner /> Enumerating tools…</div>}
      <div className="servers">
        {data?.servers.map((s) => (
          <section key={s.id} className={`card server-card ${s.id}`}>
            <header className="card-head">
              <h3><ServerChip server={s.id} /> {s.label} MCP server</h3>
              <div className="card-aside">{s.ok ? <Badge tone="good">reachable · {ms(s.latencyMs)}</Badge> : <Badge tone="bad">unreachable</Badge>}</div>
            </header>
            <div className="card-body">
              <dl className="facts">
                <dt>Runtime ARN</dt><dd><code className="wrap">{s.runtimeArn ?? 'local (not deployed)'}</code></dd>
                <dt>Endpoint</dt><dd><code className="wrap">{s.endpoint}</code></dd>
                <dt>Transport</dt><dd>MCP {s.transport ?? 'streamable-http'} (stateless)</dd>
                <dt>Inbound auth</dt><dd>{s.auth}</dd>
              </dl>
              {s.error && <div className="alert bad small">{s.error}</div>}
              <h4>{s.tools.length} tools</h4>
              <ul className="tool-list">
                {s.tools.map((t) => (
                  <li key={t.name}>
                    <div><code className="tool-name">{t.name}</code> {t.annotations?.readOnlyHint ? <Badge tone="neutral">read-only</Badge> : null}</div>
                    <div className="muted small">{t.description}</div>
                    <Json value={t.inputSchema} label="inputSchema" />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
