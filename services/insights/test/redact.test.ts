import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../src/redact.js';

test('redact removes credentials but keeps design details', () => {
  const out = redact({
    msg: 'key AKIAABCDEFGHIJKLMNOP and ASIAABCDEFGHIJKLMNOP used',
    jwt: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstu',
    line: '{"password":"hunter22","user":"claims.analyst"}',
    url: 'https://x.s3.amazonaws.com/o?X-Amz-Credential=AKIA/2026&X-Amz-Signature=abc123',
    password: 'aaaaaa',
    nested: [{ 'x-auth-token': 'abc', modelId: 'us.anthropic.claude-sonnet-4-6' }],
    arn: 'arn:aws:bedrock-agentcore:us-east-1:154833006816:runtime/claims_policy_mcp-IwUEtD845R',
  });
  const s = JSON.stringify(out);
  for (const secret of ['AKIAABCDEFGHIJKLMNOP', 'ASIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9', 'hunter22', 'abc123', 'aaaaaa']) assert.ok(!s.includes(secret), secret);
  assert.ok(s.includes('claims.analyst') && s.includes('us.anthropic.claude-sonnet-4-6') && s.includes('claims_policy_mcp-IwUEtD845R'));
});
