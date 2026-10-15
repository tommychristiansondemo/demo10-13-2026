// MCP client side of the boundary: one Client per MCP server, over Streamable HTTP.
// Deployed: AgentCore Runtime invocation URL + SigV4. Local: plain http://localhost URL.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { config, type McpServerConfig } from './config.js';
import { agentCoreRuntimeUrl, createSigV4Fetch } from './sigv4-fetch.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ToolCallResult {
  ok: boolean;
  data: unknown;
  latencyMs: number;
}

/** AgentCore routes requests with the same session id to the same microVM; ids must be >= 33 chars. */
export function newRuntimeSessionId(prefix = 'cwb'): string {
  return `${prefix}-${randomUUID()}-${Date.now()}`;
}

export class McpConnection {
  private client?: Client;

  constructor(
    readonly server: McpServerConfig,
    private readonly runtimeSessionId: string = newRuntimeSessionId(),
  ) {}

  get endpoint(): string {
    if (this.server.localUrl) return this.server.localUrl;
    if (!this.server.runtimeArn) throw new Error(`MCP server ${this.server.id} has no runtime ARN or local URL configured`);
    return agentCoreRuntimeUrl(config.region, this.server.runtimeArn);
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const url = new URL(this.endpoint);
    const transport = this.server.localUrl
      ? new StreamableHTTPClientTransport(url)
      : new StreamableHTTPClientTransport(url, {
          fetch: createSigV4Fetch(config.region, {
            'x-amzn-bedrock-agentcore-runtime-session-id': this.runtimeSessionId,
          }),
        });
    const client = new Client({ name: 'claims-workbench-orchestrator', version: '1.0.0' });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async listTools(): Promise<McpTool[]> {
    const client = await this.connect();
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      annotations: t.annotations as Record<string, unknown> | undefined,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const started = Date.now();
    try {
      const client = await this.connect();
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // tool errors come back as plain text
      }
      return { ok: !result.isError, data, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, data: { error: (err as Error).message }, latencyMs: Date.now() - started };
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }
}

/** Open one connection per configured MCP server, sharing a runtime session id prefix for the request. */
export function openConnections(sessionPrefix = 'cwb'): Map<McpServerConfig['id'], McpConnection> {
  return new Map(config.mcpServers.map((s) => [s.id, new McpConnection(s, newRuntimeSessionId(`${sessionPrefix}-${s.id}`))]));
}

export async function closeAll(conns: Map<string, McpConnection>): Promise<void> {
  await Promise.all([...conns.values()].map((c) => c.close()));
}
