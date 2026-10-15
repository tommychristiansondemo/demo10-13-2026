import assert from 'node:assert/strict';
import { test } from 'node:test';

test('SigV4 fetch signs AgentCore runtime invocations', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'secret';
  delete process.env.AWS_PROFILE;
  const { agentCoreRuntimeUrl, createSigV4Fetch } = await import('../src/sigv4-fetch.js');
  const arn = 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/claims_policy_mcp-abc123';
  const url = agentCoreRuntimeUrl('us-east-1', arn);
  assert.equal(url, `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`);

  let captured: { url: string; headers: Record<string, string> } | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: URL, init: RequestInit) => {
    captured = { url: u.toString(), headers: init.headers as Record<string, string> };
    return new Response('{}');
  }) as typeof fetch;
  try {
    const f = createSigV4Fetch('us-east-1', { 'x-amzn-bedrock-agentcore-runtime-session-id': 's'.repeat(40) });
    await f(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0"}' });
  } finally {
    globalThis.fetch = real;
  }
  const auth = captured!.headers.authorization;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-agentcore\/aws4_request/);
  assert.match(auth, /SignedHeaders=[^,]*x-amzn-bedrock-agentcore-runtime-session-id/);
  assert.ok(captured!.headers['x-amz-date'] && captured!.headers['x-amz-content-sha256']);
  assert.equal(captured!.url, url);
});
