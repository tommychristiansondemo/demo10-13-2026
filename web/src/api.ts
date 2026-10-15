// API client. Requests go to /api/* on the same origin (CloudFront -> Lambda Function URL via OAC).
import type { RunRecord, StreamEvent } from '../../services/api/src/events';
import { accessToken } from './auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function sha256Hex(body: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'x-auth-token': accessToken() ?? '' };
  let payload: string | undefined;
  if (method !== 'GET') {
    payload = JSON.stringify(body ?? {});
    headers['content-type'] = 'application/json';
    // CloudFront OAC to a Lambda Function URL requires the payload hash for POST/PUT.
    headers['x-amz-content-sha256'] = await sha256Hex(payload);
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? err.message ?? res.statusText);
  }
  return res;
}

export const api = {
  get: async <T,>(path: string): Promise<T> => (await request('GET', path)).json(),
  post: async <T,>(path: string, body?: unknown): Promise<T> => (await request('POST', path, body)).json(),

  /** POST and consume an NDJSON event stream. */
  async stream(path: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await request('POST', path);
    await readNdjson(res.body!, onEvent, signal);
  },
};

export async function readNdjson(body: ReadableStream<Uint8Array>, onEvent: (e: StreamEvent) => void, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (!signal?.aborted) {
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
  if (buf.trim()) onEvent(JSON.parse(buf));
}

/** Replays a recorded run (web/public/fallback/<claim>.ndjson) with realistic pacing - the demo fallback. */
export async function replayRecorded(claimId: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(`/fallback/${claimId}.ndjson`, { cache: 'no-store' });
  if (!res.ok || !res.headers.get('content-type')?.match(/ndjson|octet|text\/plain/)) return false;
  const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamEvent);
  for (const e of events) {
    if (signal?.aborted) break;
    if (e.type === 'ping') continue;
    await new Promise((r) => setTimeout(r, e.type === 'model_turn' ? 900 : e.type === 'tool_result' ? 250 : 120));
    onEvent(e);
  }
  return true;
}

export async function hasRecording(claimId: string): Promise<boolean> {
  try {
    const res = await fetch(`/fallback/${claimId}.ndjson`, { method: 'HEAD', cache: 'no-store' });
    return res.ok && !res.headers.get('content-type')?.includes('text/html');
  } catch {
    return false;
  }
}

export type { RunRecord, StreamEvent };
