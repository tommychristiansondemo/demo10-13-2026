// Lambda entry point: Function URL with RESPONSE_STREAM invoke mode, behind CloudFront (OAC).
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Writable } from 'node:stream';
import { route } from './router.js';

declare const awslambda: {
  streamifyResponse(fn: (event: APIGatewayProxyEventV2, stream: Writable) => Promise<void>): unknown;
  HttpResponseStream: { from(stream: Writable, meta: { statusCode: number; headers: Record<string, string> }): Writable };
};

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : undefined;
  const finish = (s: Writable) => new Promise<void>((resolve) => s.end(resolve));

  await route(
    { method: event.requestContext.http.method, path: event.rawPath, headers: event.headers ?? {}, body },
    {
      async json(status, payload) {
        const s = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: status,
          headers: { ...BASE_HEADERS, 'content-type': 'application/json' },
        });
        s.write(JSON.stringify(payload));
        await finish(s);
      },
      ndjson() {
        const s = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 200,
          headers: { ...BASE_HEADERS, 'content-type': 'application/x-ndjson' },
        });
        return { write: (obj) => void s.write(JSON.stringify(obj) + '\n'), end: () => finish(s) };
      },
    },
  );
});
