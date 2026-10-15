// The agent's third evidence source: an Amazon Bedrock Knowledge Base holding the (synthetic) claims-handling manual.
// Retrieve = embed the query (Titan Text Embeddings V2) + nearest-neighbour search in the S3 Vectors index.
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { config } from './config.js';

const client = new BedrockAgentRuntimeClient({ region: config.region });

export const KB_TOOL = 'search_guidelines';
export const kbToolSpec = {
  name: `knowledge_base__${KB_TOOL}`,
  description:
    '[Claims Manual - Amazon Bedrock Knowledge Base] Semantic search over the carrier\'s claims-handling manual (authority levels, ' +
    'coverage/driver rules, estimate review standards, total loss, SIU referral indicators, injury escalation, subrogation, ' +
    'glass and catastrophe handling). Returns the most relevant passages with their section ids (CHM-xxx). Use it to find the ' +
    'procedure that applies; it does not contain claim data.',
  inputSchema: {
    json: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What procedure or rule you need, e.g. "SIU referral indicators hit and run late police report".' },
        max_results: { type: 'integer', minimum: 1, maximum: 6, description: 'default 4' },
      },
    },
  },
};

export async function searchGuidelines(args: { query?: unknown; max_results?: unknown }): Promise<{ ok: boolean; data: unknown; latencyMs: number }> {
  const t0 = Date.now();
  const query = String(args.query ?? '').trim().slice(0, 1000);
  if (!query) return { ok: false, data: { error: 'query is required' }, latencyMs: 0 };
  try {
    const r = await client.send(new RetrieveCommand({
      knowledgeBaseId: config.knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: Math.min(Math.max(Number(args.max_results) || 4, 1), 6) } },
    }));
    const passages = (r.retrievalResults ?? []).map((x) => {
      const text = x.content?.text ?? '';
      const uri = x.location?.s3Location?.uri ?? '';
      return {
        section: [...text.matchAll(/CHM-\d{3}/g)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3),
        document: uri.split('/').pop(),
        score: x.score != null ? Number(x.score.toFixed(3)) : null,
        text,
      };
    });
    return { ok: true, data: { source: `Bedrock Knowledge Base ${config.knowledgeBaseId} (claims-handling manual)`, query, passages }, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, data: { error: (err as Error).message }, latencyMs: Date.now() - t0 };
  }
}
