// The AI orchestrator: a Bedrock Converse tool-use loop over the tools discovered from both MCP servers, plus a
// search tool over the Bedrock Knowledge Base (claims-handling manual).
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';
import { getActiveModel } from './appconfig.js';
import { config } from './config.js';
import { MCP_SERVER_IDS, type EvidenceItem, type Recommendation, type RunRecord, type RunValidation, type ServerId, type StreamEvent } from './events.js';
import { kbToolSpec, KB_TOOL, searchGuidelines } from './knowledge-base.js';
import { closeAll, McpConnection, openConnections } from './mcp.js';
import { log, metric } from './observability.js';
import { costUsd, type ModelEntry } from './model-routing.js';
import { SUBMIT_TOOL, submitToolSpec, systemPrompt } from './prompt.js';

const SEP = '__';
const clip = (v: unknown, n: number): string => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more chars]` : t;
};

/** What the model saw as new input on this turn (the first user message, or the tool results / nudge it just got). */
function describeInput(m: Message): unknown[] {
  return (m.content ?? []).map((b) =>
    b.text !== undefined
      ? { text: clip(b.text, 2000) }
      : b.toolResult
        ? { toolResult: b.toolResult.toolUseId, status: b.toolResult.status, content: clip(b.toolResult.content?.[0]?.json ?? b.toolResult.content?.[0]?.text, 1500) }
        : { other: Object.keys(b)[0] },
  );
}

export interface ConverseLike {
  send(cmd: ConverseCommand): Promise<{
    output?: { message?: Message };
    stopReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
  }>;
}

let defaultBedrock: ConverseLike | undefined;
const bedrock = () => (defaultBedrock ??= new BedrockRuntimeClient({ region: config.region }) as unknown as ConverseLike);

/** Bedrock tool schemas are self-contained; inline any $ref/$defs that pydantic emits. */
export function inlineRefs(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = (schema.$defs ?? schema.definitions ?? {}) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.$ref === 'string') {
        const name = obj.$ref.split('/').pop()!;
        return walk(defs[name]);
      }
      return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== '$defs' && k !== 'definitions').map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(schema) as Record<string, unknown>;
}

export interface RunOptions {
  claimId: string;
  requestedBy: string;
  emit: (e: StreamEvent) => void;
  converse?: ConverseLike;
  /** Defaults to the live AppConfig selection; the benchmark passes each candidate explicitly. */
  model?: ModelEntry;
  connections?: Map<ServerId, McpConnection>;
}

export async function runAnalysis(opts: RunOptions): Promise<RunRecord> {
  const { claimId, emit } = opts;
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  const conns = opts.connections ?? openConnections(`run-${runId}`);
  const converse = opts.converse ?? bedrock();
  // Resolved once per run: a model switch mid-run never mixes two models in one conversation.
  const model = opts.model ?? (await getActiveModel());
  const { modelId } = model;
  let totalCost = 0;
  const evidence: EvidenceItem[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const warnings: string[] = [];
  let recommendation: Recommendation | undefined;
  let error: string | undefined;

  emit({
    type: 'run_started',
    runId,
    claimId,
    modelId,
    modelName: model.name,
    servers: [...conns.values()].map((c) => ({ id: c.server.id, label: c.server.label, endpoint: c.server.runtimeArn ?? c.endpoint })),
  });

  try {
    // 1. Discover tools from both MCP servers (in parallel) and expose them to the model, namespaced by server.
    const toolSpecs: Tool[] = [];
    await Promise.all(
      [...conns.values()].map(async (conn) => {
        const t0 = Date.now();
        const tools = await conn.listTools();
        emit({ type: 'tools_discovered', server: conn.server.id, tools: tools.map((t) => t.name), latencyMs: Date.now() - t0 });
        for (const t of tools) {
          toolSpecs.push({
            toolSpec: {
              name: `${conn.server.id}${SEP}${t.name}`,
              description: `[${conn.server.label} MCP] ${t.description ?? ''}`.slice(0, 1000),
              inputSchema: { json: inlineRefs(t.inputSchema) as never },
            },
          });
        }
      }),
    );
    // 2nd kind of evidence source: the Bedrock Knowledge Base (claims-handling manual), called directly, not over MCP.
    if (config.knowledgeBaseId) {
      toolSpecs.push({ toolSpec: kbToolSpec as never });
      emit({ type: 'tools_discovered', server: 'knowledge_base', tools: [KB_TOOL], latencyMs: 0 });
    }
    toolSpecs.sort((a, b) => a.toolSpec!.name!.localeCompare(b.toolSpec!.name!)); // stable order => prompt cache hits
    toolSpecs.push({ toolSpec: submitToolSpec as never });
    // Prompt caching only for models that support cachePoint (the Claude models here); others reject the block.
    if (model.invocation.promptCache) toolSpecs.push({ cachePoint: { type: 'default' } } as Tool);

    const messages: Message[] = [
      { role: 'user', content: [{ text: `Analyze claim ${claimId} and submit a recommended next-action plan.` }] },
    ];
    let nudged = false;
    const system = systemPrompt(claimId, !!config.knowledgeBaseId);
    // Reasoning log: the full prompt once per run, then one llm_call line per model call (input, reasoning, output).
    log('llm_prompt', {
      app: 'claims-workbench', runId, claimId, modelId, modelKey: model.key, modelName: model.name, reasoning: model.invocation.reasoning,
      systemPrompt: system, tools: toolSpecs.filter((t) => t.toolSpec).map((t) => t.toolSpec!.name), userMessage: messages[0].content![0].text,
    });

    // 2. Tool-use loop.
    for (let turn = 1; turn <= config.maxAgentTurns && !recommendation; turn++) {
      const t0 = Date.now();
      const res = await converse.send(
        new ConverseCommand({
          modelId,
          system: model.invocation.promptCache ? [{ text: system }, { cachePoint: { type: 'default' } }] : [{ text: system }],
          messages,
          toolConfig: { tools: toolSpecs },
          // Extended (adaptive) thinking: the model decides how much to reason; its reasoning is logged below.
          // Thinking requires the default temperature, so none is set.
          ...(model.invocation.reasoning === 'adaptive'
            ? { inferenceConfig: { maxTokens: model.invocation.maxTokens }, additionalModelRequestFields: { thinking: { type: 'adaptive' } } }
            : { inferenceConfig: { maxTokens: model.invocation.maxTokens, temperature: 0 } }),
        }),
      );
      const u = res.usage ?? {};
      usage.inputTokens += u.inputTokens ?? 0;
      usage.outputTokens += u.outputTokens ?? 0;
      usage.cacheReadTokens += u.cacheReadInputTokens ?? 0;
      usage.cacheWriteTokens += u.cacheWriteInputTokens ?? 0;
      const latencyMs = Date.now() - t0;
      const callCost = costUsd(model, { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cacheReadInputTokens ?? 0, cacheWriteTokens: u.cacheWriteInputTokens ?? 0 });
      totalCost += callCost;
      emit({ type: 'model_turn', turn, latencyMs, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 });
      const message = res.output?.message ?? { role: 'assistant', content: [] };
      const out = message.content ?? [];
      log('llm_call', {
        app: 'claims-workbench', runId, claimId, turn, modelId, modelKey: model.key, modelName: model.name, latencyMs, stopReason: res.stopReason, usage: u,
        costUsd: Number(callCost.toFixed(6)), pricing: model.pricing,
        input: describeInput(messages[messages.length - 1]),
        reasoning: out.filter((b) => b.reasoningContent).map((b) => clip(b.reasoningContent?.reasoningText?.text ?? '[redacted by model]', 8000)),
        outputText: out.filter((b) => b.text?.trim()).map((b) => clip(b.text, 2000)),
        toolCalls: out.filter((b) => b.toolUse).map((b) => ({ name: b.toolUse!.name, input: clip(b.toolUse!.input, 3000) })),
      });

      messages.push(message); // keep reasoning blocks: the model needs them when it continues after tool results
      const content = out;
      // DeepSeek V3.2 sometimes echoes the start of its native tool-call markup ("<｜DSML｜function_calls") before the real
      // toolUse block; drop it from the UI stream (the reasoning log above keeps the raw text).
      for (const block of content) {
        const text = block.text?.replace(/<｜DSML｜[\s\S]*$/, '').trim();
        if (text) emit({ type: 'model_text', text, turn });
      }

      const toolUses = content.filter((b): b is ContentBlock.ToolUseMember => !!b.toolUse);
      if (toolUses.length === 0) {
        if (nudged) throw new Error('Model ended without calling submit_recommendation');
        nudged = true;
        messages.push({ role: 'user', content: [{ text: `Call ${SUBMIT_TOOL} now with your final recommendation.` }] });
        continue;
      }

      const results = await Promise.all(
        toolUses.map(async ({ toolUse }): Promise<ContentBlock> => {
          const toolUseId = toolUse.toolUseId!;
          const name = toolUse.name!;
          const args = (toolUse.input ?? {}) as Record<string, unknown>;
          if (name === SUBMIT_TOOL) {
            recommendation = normalizeRecommendation(args, warnings);
            return { toolResult: { toolUseId, content: [{ text: 'Recommendation received for supervisor review.' }] } };
          }
          const [serverId, tool] = name.split(SEP) as [ServerId, string];
          const conn = conns.get(serverId);
          const evidenceId = `E${evidence.length + 1}`;
          const isKb = serverId === 'knowledge_base';
          const item: EvidenceItem = { id: evidenceId, server: serverId, serverLabel: isKb ? 'Claims Manual (Bedrock KB)' : conn?.server.label ?? serverId, tool, args, ok: false, latencyMs: 0, result: null };
          evidence.push(item); // reserve the id synchronously so parallel calls get distinct ids
          emit({ type: 'tool_call', toolUseId, evidenceId, server: serverId, tool, args, turn });

          const r = isKb ? await searchGuidelines(args) : conn ? await conn.callTool(tool, args) : { ok: false, data: { error: `Unknown tool ${name}` }, latencyMs: 0 };
          Object.assign(item, { ok: r.ok, latencyMs: r.latencyMs, result: r.data });
          emit({ type: 'tool_result', evidence: item });
          metric('ToolCallLatency', r.latencyMs, 'Milliseconds', { Server: serverId, Tool: tool });
          metric(r.ok ? 'ToolCallSuccess' : 'ToolCallError', 1, 'Count', { Server: serverId });
          log('mcp_tool_call', { runId, claimId, evidenceId, server: serverId, tool, ok: r.ok, latencyMs: r.latencyMs });

          const payload: ToolResultContentBlock = { json: { evidence_id: evidenceId, server: serverId, tool, result: r.data } as never };
          return { toolResult: { toolUseId, content: [payload], status: r.ok ? 'success' : 'error' } };
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    if (!recommendation) throw new Error(`No recommendation after ${config.maxAgentTurns} model turns`);
  } catch (err) {
    error = (err as Error).message;
    log('analysis_error', { runId, claimId, error });
    emit({ type: 'error', message: error });
  } finally {
    if (!opts.connections) await closeAll(conns);
  }

  const validation = validate(recommendation, evidence, warnings);
  if (recommendation) emit({ type: 'recommendation', recommendation, validation });

  const run: RunRecord = {
    claimId,
    runId,
    createdAt: new Date(started).toISOString(),
    requestedBy: opts.requestedBy,
    modelId,
    modelKey: model.key,
    modelName: model.name,
    costUsd: Number(totalCost.toFixed(6)),
    status: recommendation ? 'PENDING_APPROVAL' : 'FAILED',
    durationMs: Date.now() - started,
    usage,
    recommendation,
    evidence,
    validation,
    ...(error ? { error } : {}),
  };
  metric('AnalysisDuration', run.durationMs, 'Milliseconds', {});
  metric(recommendation ? 'AnalysisSuccess' : 'AnalysisFailure', 1, 'Count', {});
  metric('InputTokens', usage.inputTokens, 'Count', {});
  metric('OutputTokens', usage.outputTokens, 'Count', {});
  metric('AnalysisSuccessByModel', recommendation ? 1 : 0, 'Count', { Model: model.key });
  return run;
}

/**
 * Models differ in how faithfully they fill a large tool schema (some send nested objects as JSON strings, or skip
 * sections). Repair what is safely repairable and record a warning, so the grounding checks and the UI never crash.
 */
export function normalizeRecommendation(args: Record<string, unknown>, warnings: string[]): Recommendation {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
      try {
        r[k] = JSON.parse(v);
        warnings.push(`Model sent "${k}" as a JSON string; parsed it.`);
        continue;
      } catch {
        /* keep the string */
      }
    }
    r[k] = v;
  }
  const obj = (k: string, d: Record<string, unknown>) => {
    if (!r[k] || typeof r[k] !== 'object' || Array.isArray(r[k])) {
      warnings.push(`Recommendation is missing "${k}".`);
      r[k] = d;
    }
    const o = r[k] as Record<string, unknown>;
    if (!Array.isArray(o.evidence)) o.evidence = [];
  };
  const arr = (k: string) => {
    if (!Array.isArray(r[k])) {
      if (r[k] !== undefined) warnings.push(`"${k}" was not a list.`);
      r[k] = [];
    }
    for (const it of r[k] as Record<string, unknown>[]) if (it && typeof it === 'object' && !Array.isArray(it.evidence)) it.evidence = [];
  };
  for (const k of ['headline', 'incident_summary', 'confidence_rationale']) if (typeof r[k] !== 'string') r[k] = String(r[k] ?? '');
  if (typeof r.disposition !== 'string') {
    warnings.push('Recommendation has no disposition.');
    r.disposition = 'COVERAGE_REVIEW';
  }
  obj('coverage_position', { verdict: 'UNKNOWN', explanation: '' });
  obj('damage_position', { summary: '' });
  obj('estimate_review', { shop_estimate_total: null, unsupported_amount: 0, missing_operations_amount: 0, net_adjustment: 0, summary: '' });
  arr('next_actions');
  arr('risk_flags');
  arr('open_questions');
  r.open_questions = (r.open_questions as unknown[]).filter((q) => typeof q === 'string');
  if (!Array.isArray(r.additional_dispositions)) r.additional_dispositions = [];
  if (typeof r.confidence !== 'string') r.confidence = 'LOW';
  return r as unknown as Recommendation;
}

/** Server-side grounding checks: citations must point at real evidence; both MCP servers must have been used. */
export function validate(rec: Recommendation | undefined, evidence: EvidenceItem[], warnings: string[]): RunValidation {
  const known = new Set(evidence.map((e) => e.id));
  const invalid = new Set<string>();
  const scrub = (ids: string[] | undefined) => (ids ?? []).filter((id) => (known.has(id) ? true : (invalid.add(id), false)));
  const serversUsed = [...new Set(evidence.filter((e) => e.ok).map((e) => e.server))].sort() as ServerId[];

  if (rec) {
    rec.coverage_position.evidence = scrub(rec.coverage_position?.evidence);
    rec.damage_position.evidence = scrub(rec.damage_position?.evidence);
    rec.estimate_review.evidence = scrub(rec.estimate_review?.evidence);
    for (const a of rec.next_actions ?? []) a.evidence = scrub(a.evidence);
    for (const f of rec.risk_flags ?? []) f.evidence = scrub(f.evidence);
    if (!rec.coverage_position.evidence.length) warnings.push('Coverage position has no valid citation.');
    if (!rec.damage_position.evidence.length) warnings.push('Damage position has no valid citation.');
    const uncited = (rec.next_actions ?? []).filter((a) => !a.evidence.length).length;
    if (uncited) warnings.push(`${uncited} next action(s) have no valid citation.`);
  }
  if (invalid.size) warnings.push(`Removed citations to unknown evidence: ${[...invalid].join(', ')}`);
  if (MCP_SERVER_IDS.some((id) => !serversUsed.includes(id))) warnings.push('Recommendation did not use both MCP servers.');
  const failed = evidence.filter((e) => !e.ok).length;
  if (failed) warnings.push(`${failed} tool call(s) failed.`);
  return { serversUsed, toolCalls: evidence.length, invalidCitations: [...invalid], warnings };
}
