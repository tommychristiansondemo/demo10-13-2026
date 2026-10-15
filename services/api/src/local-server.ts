// Local dev server: same router, node:http transport, MCP servers on localhost, auth bypassed.
//   CLAIMS_MCP_URL=http://127.0.0.1:8001/mcp DAMAGE_MCP_URL=http://127.0.0.1:8002/mcp LOCAL_DEV=1 npx tsx services/api/src/local-server.ts
// The AI analysis route also needs AWS credentials with Bedrock access in the shell.
import { createServer } from 'node:http';
import { route } from './router.js';

const port = Number(process.env.API_PORT ?? 8787);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));
  await route(
    { method: req.method ?? 'GET', path: new URL(req.url ?? '/', 'http://x').pathname, headers, body: Buffer.concat(chunks).toString('utf8') },
    {
      async json(status, body) {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      },
      ndjson() {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return { write: (o) => void res.write(JSON.stringify(o) + '\n'), end: async () => void res.end() };
      },
    },
  );
}).listen(port, () => console.log(`API listening on http://127.0.0.1:${port}`));
