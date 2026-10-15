// Same-origin API: CloudFront routes /api/insights/chat and /api/insights/* to two Lambda Function URLs (OAC).
import { accessToken } from './auth';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function sha256Hex(body: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { 'x-auth-token': accessToken() ?? '' } });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return res.json();
}

export type ChatEvent =
  | { type: 'reasoning' | 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'turn_break' | 'ping' }
  | { type: 'done'; usage: Record<string, number>; requestId: string; conversationId: string; ms: number }
  | { type: 'error'; message: string };

export async function chat(body: unknown, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  const payload = JSON.stringify(body);
  const res = await fetch('/api/insights/chat', {
    method: 'POST',
    signal,
    headers: { 'x-auth-token': accessToken() ?? '', 'content-type': 'application/json', 'x-amz-content-sha256': await sha256Hex(payload) },
    body: payload,
  });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}
