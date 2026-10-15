import { useEffect, useState } from 'react';
import { get } from '../api';
import { Markdown } from '../markdown';

export function Knowledge() {
  const [k, setK] = useState<{ bucket: string; key: string; lastModified?: string; markdown: string }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    get<typeof k>('/api/insights/knowledge').then(setK, (e) => setError(e.message));
  }, []);
  if (error) return <div className="page"><div className="alert bad">{error}</div></div>;
  if (!k) return <div className="page"><span className="spinner" /> Loading projectknowledge.md…</div>;
  return (
    <div className="page">
      <div className="source-note">
        <code>s3://{k.bucket}/{k.key}</code> · last published {k.lastModified ? new Date(k.lastModified).toLocaleString() : 'unknown'} · this is
        exactly what the chatbot reads
      </div>
      <Markdown text={k.markdown} className="knowledge card" />
    </div>
  );
}
