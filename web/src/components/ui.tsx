import { useState, type ReactNode } from 'react';
import { ms, SERVER_LABEL } from '../format';

export function ServerChip({ server }: { server: string }) {
  return <span className={`server-chip ${server}`}>{SERVER_LABEL[server] ?? server}</span>;
}

/** "Fetched via MCP" provenance line shown under data the page got from an MCP tool. */
export function Via({ server, tool, latencyMs }: { server: string; tool: string; latencyMs?: number }) {
  return (
    <span className="via" title="This data was fetched through an MCP tool call">
      <ServerChip server={server} />
      <code>{tool}</code>
      {latencyMs != null && <span className="muted">{ms(latencyMs)}</span>}
    </span>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'good' | 'warn' | 'bad' | 'info' | 'neutral'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Card({ title, aside, children, className = '' }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <h3>{title}</h3>
        {aside && <div className="card-aside">{aside}</div>}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Json({ value, collapsed = true, label = 'JSON' }: { value: unknown; collapsed?: boolean; label?: string }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div className="json">
      <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <pre>{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

export function Meter({ value, max = 1, tone }: { value: number; max?: number; tone?: string }) {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="meter" role="meter" aria-valuenow={value} aria-valuemax={max}>
      <span className={`meter-fill ${tone ?? (w >= 75 ? 'bad' : w >= 50 ? 'warn' : 'good')}`} style={{ width: `${w}%` }} />
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}
