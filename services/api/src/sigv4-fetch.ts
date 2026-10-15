// A fetch() that signs every request with SigV4 for the bedrock-agentcore service.
// The MCP SDK's Streamable HTTP transport accepts a custom fetch, so the official MCP client can
// talk to an AgentCore Runtime that uses IAM (the default) inbound auth. No AWS credentials ever
// reach the browser: only this Lambda's execution role can invoke the runtimes.
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export function agentCoreRuntimeUrl(region: string, runtimeArn: string, qualifier = 'DEFAULT'): string {
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=${qualifier}`;
}

export function createSigV4Fetch(region: string, extraHeaders: Record<string, string> = {}) {
  const signer = new SignatureV4({ service: 'bedrock-agentcore', region, credentials: defaultProvider(), sha256: Sha256 });

  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input.toString());
    const headers: Record<string, string> = { host: url.host, ...extraHeaders };
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === 'string' ? init.body : init.body == null ? undefined : String(init.body);

    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    const signed = await signer.sign(
      new HttpRequest({
        method: init.method ?? 'GET',
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        query,
        headers,
        body,
      }),
    );
    const { host: _host, ...sendHeaders } = signed.headers;
    return fetch(url, { ...init, headers: sendHeaders, body });
  };
}
