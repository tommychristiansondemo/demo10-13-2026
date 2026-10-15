import { useEffect, useRef, useState, type FormEvent } from 'react';
import { chat, type ChatEvent } from '../api';
import { Markdown } from '../markdown';

interface ToolStep { name: string; input: unknown; ok?: boolean; summary?: string }
interface Turn { role: 'user' | 'assistant'; text: string; reasoning?: string; tools?: ToolStep[]; meta?: string; error?: string }

const SUGGESTIONS = [
  'Where does the Claims Workbench get its data?',
  'How many different types of AWS resources are deployed right now?',
  'Which LLM does each app use, and why?',
  'Show me what the agent reasoned during the most recent claim analysis.',
  'How do the two MCP servers on AgentCore Runtime work together?',
  'How does student self-registration assign the analyst or supervisor role?',
  'What did this chatbot reason when answering the last question?',
  'Have there been any errors in the last hour?',
];

export function Ask() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const conversationId = useRef(crypto.randomUUID());
  const abort = useRef<AbortController>(null);
  const end = useRef<HTMLDivElement>(null);
  // Block body: newer Chrome returns a Promise from scrollIntoView, which React would treat as a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    const history = [...turns, { role: 'user' as const, text: question.trim() }];
    setTurns([...history, { role: 'assistant', text: '', reasoning: '', tools: [] }]);
    setInput('');
    setBusy(true);
    const patch = (f: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), f(ts[ts.length - 1])]);
    abort.current = new AbortController();
    try {
      await chat(
        { conversationId: conversationId.current, messages: history.filter((t) => t.text).map((t) => ({ role: t.role, content: t.text })) },
        (e: ChatEvent) => {
          if (e.type === 'text') patch((t) => ({ ...t, text: t.text + e.text }));
          else if (e.type === 'reasoning') patch((t) => ({ ...t, reasoning: (t.reasoning ?? '') + e.text }));
          else if (e.type === 'turn_break') patch((t) => ({ ...t, text: t.text && !t.text.endsWith('\n\n') ? t.text + '\n\n' : t.text, reasoning: t.reasoning ? t.reasoning + '\n\n' : t.reasoning }));
          else if (e.type === 'tool_call') patch((t) => ({ ...t, tools: [...(t.tools ?? []), { name: e.name, input: e.input }] }));
          else if (e.type === 'tool_result')
            patch((t) => {
              const tools = [...(t.tools ?? [])];
              const i = tools.findIndex((x) => x.name === e.name && x.ok === undefined);
              if (i >= 0) tools[i] = { ...tools[i], ok: e.ok, summary: e.summary };
              return { ...t, tools };
            });
          else if (e.type === 'done') patch((t) => ({ ...t, meta: `${(e.ms / 1000).toFixed(1)} s · ${e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens} input / ${e.usage.outputTokens} output tokens · request ${e.requestId}` }));
          else if (e.type === 'error') patch((t) => ({ ...t, error: e.message }));
        },
        abort.current.signal,
      );
    } catch (err) {
      patch((t) => ({ ...t, error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(input);
  };

  return (
    <div className="page ask">
      <div className="page-head">
        <div>
          <h1>Ask about the class deployment</h1>
          <p className="muted">
            Answers come from <b>projectknowledge.md</b> in S3 plus live, read-only tools (CloudFormation, AgentCore, Lambda, CloudWatch Logs and
            metrics). Claude Sonnet 4.6 on Amazon Bedrock, with extended thinking. Its reasoning is shown as it streams.
          </p>
        </div>
        {turns.length > 0 && (
          <button className="ghost" disabled={busy} onClick={() => { setTurns([]); conversationId.current = crypto.randomUUID(); }}>New chat</button>
        )}
      </div>

      {turns.length === 0 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggestion" onClick={() => void ask(s)}>{s}</button>
          ))}
        </div>
      )}

      <div className="chat">
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="msg user"><div className="bubble">{t.text}</div></div>
          ) : (
            <div key={i} className="msg assistant">
              {(t.reasoning || (busy && i === turns.length - 1 && !t.text)) && (
                <details className="reasoning" open={busy && i === turns.length - 1 && !t.text}>
                  <summary>Model reasoning {busy && i === turns.length - 1 && !t.text && <span className="spinner" />}</summary>
                  <pre>{t.reasoning || 'Thinking…'}</pre>
                </details>
              )}
              {(t.tools ?? []).length > 0 && (
                <div className="tool-steps">
                  {t.tools!.map((s, j) => (
                    <details key={j} className={`tool-step ${s.ok === false ? 'bad' : ''}`}>
                      <summary>
                        <code>{s.name}</code> {s.ok === undefined ? <span className="spinner" /> : s.ok ? '✓' : '✗'}
                        <span className="muted small"> {JSON.stringify(s.input)}</span>
                      </summary>
                      {s.summary && <pre>{s.summary}</pre>}
                    </details>
                  ))}
                </div>
              )}
              {t.text && <Markdown text={t.text} className="answer" />}
              {t.error && <div className="alert bad small">{t.error}</div>}
              {t.meta && <div className="muted small meta">{t.meta}</div>}
            </div>
          ),
        )}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          name="question"
          value={input}
          rows={2}
          maxLength={4000}
          placeholder="Ask anything about how the apps were built, deployed, or are behaving…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
        />
        {busy ? (
          <button type="button" className="ghost" onClick={() => abort.current?.abort()}>Stop</button>
        ) : (
          <button type="submit" className="primary" disabled={!input.trim()}>Ask</button>
        )}
      </form>
    </div>
  );
}
