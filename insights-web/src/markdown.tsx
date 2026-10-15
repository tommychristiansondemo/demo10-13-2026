import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

marked.setOptions({ gfm: true, breaks: false });

/** Model output and the knowledge file are rendered as Markdown, sanitized (no scripts, no event handlers). */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
