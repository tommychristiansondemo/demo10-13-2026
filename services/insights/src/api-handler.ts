// Class Insights data API (Lambda Function URL behind CloudFront OAC). Read-only, signed-in users only.
//   GET /api/insights/health | me | knowledge | inventory | logs/sources | logs?source=&filter=&minutes= |
//       reasoning?app=&minutes=&runId= | metrics?hours= | models | costs/llm?app=&minutes=&limit= | costs/explorer?refresh=1
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AuthError, authenticate } from './auth.js';
import { config } from './config.js';
import { getCostExplorer, getLlmCosts, getModelRouting } from './costs.js';
import { getInventory, getKnowledge, getMetrics, getReasoningLogs, listLogSources, searchLogs } from './tools.js';

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  body: JSON.stringify(body),
});
const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const started = Date.now();
  const route = event.rawPath.replace(/^\/api\/insights\/?/, '');
  const q = event.queryStringParameters ?? {};
  let user: string | undefined;
  try {
    if (event.requestContext.http.method !== 'GET') return json(405, { error: 'Method not allowed' });
    if (route === 'health') return json(200, { ok: true, modelId: config.modelId });
    user = await authenticate(event.headers['x-auth-token']);
    switch (route) {
      case 'me':
        return json(200, { username: user });
      case 'knowledge':
        return json(200, await getKnowledge());
      case 'inventory':
        return json(200, await getInventory());
      case 'logs/sources':
        return json(200, { sources: listLogSources() });
      case 'logs':
        return json(200, await searchLogs({ source: q.source ?? 'workbench-api', filter: q.filter, minutes: num(q.minutes), limit: num(q.limit) }));
      case 'reasoning':
        return json(200, await getReasoningLogs({ app: (q.app as 'all') ?? 'all', minutes: num(q.minutes), limit: num(q.limit), runId: q.runId }));
      case 'metrics':
        return json(200, await getMetrics({ hours: num(q.hours) }));
      case 'models':
        return json(200, await getModelRouting());
      case 'costs/llm':
        return json(200, await getLlmCosts({ app: (q.app as 'all') ?? 'all', minutes: num(q.minutes), limit: num(q.limit) }));
      case 'costs/explorer':
        return json(200, await getCostExplorer({ refresh: q.refresh === '1' }));
      default:
        return json(404, { error: `No route ${route}` });
    }
  } catch (e) {
    if (e instanceof AuthError) return json(401, { error: e.message });
    console.log(JSON.stringify({ log_type: 'api_error', route, user, error: (e as Error).message }));
    return json(/^Unknown log source/.test((e as Error).message) ? 400 : 500, { error: (e as Error).message });
  } finally {
    console.log(JSON.stringify({ log_type: 'api_request', route, user, ms: Date.now() - started }));
  }
}
