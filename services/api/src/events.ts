// Event + record shapes shared by the API (NDJSON stream) and the web app (type-only import).

/** Evidence sources: the two MCP servers plus the Bedrock Knowledge Base (claims manual). */
export type ServerId = 'claims_policy' | 'damage_repair' | 'knowledge_base';
export const MCP_SERVER_IDS = ['claims_policy', 'damage_repair'] as const;

export type Disposition =
  | 'APPROVE_REPAIR'
  | 'APPROVE_REPAIR_WITH_ADJUSTMENTS'
  | 'FAST_TRACK_PAYMENT'
  | 'TOTAL_LOSS_EVALUATION'
  | 'COVERAGE_REVIEW'
  | 'DENY_FIRST_PARTY'
  | 'SIU_REFERRAL'
  | 'ESCALATE_INJURY';

export type Level = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Cited {
  evidence: string[];
}

export interface NextAction extends Cited {
  action: string;
  owner: string;
  priority: Level;
  rationale: string;
}

export interface Recommendation {
  headline: string;
  disposition: Disposition;
  additional_dispositions?: Disposition[];
  incident_summary: string;
  coverage_position: Cited & { verdict: string; explanation: string };
  damage_position: Cited & { summary: string };
  estimate_review: Cited & {
    shop_estimate_total: number | null;
    unsupported_amount: number;
    missing_operations_amount: number;
    net_adjustment: number;
    summary: string;
  };
  next_actions: NextAction[];
  risk_flags: (Cited & { flag: string; severity: Level })[];
  confidence: Level;
  confidence_rationale: string;
  open_questions: string[];
}

export interface EvidenceItem {
  id: string; // E1, E2, ...
  server: ServerId;
  serverLabel: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  latencyMs: number;
  result: unknown;
}

export interface RunValidation {
  serversUsed: ServerId[];
  toolCalls: number;
  invalidCitations: string[];
  warnings: string[];
}

export type RunStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'FAILED';

export interface DecisionRecord {
  decision: 'APPROVED' | 'REJECTED' | 'RETURNED';
  by: string;
  at: string;
  comment: string;
}

export interface RunRecord {
  claimId: string;
  runId: string;
  createdAt: string;
  requestedBy: string;
  modelId: string;
  /** Catalog key / display name of the model that served this run (set from the AppConfig selection). */
  modelKey?: string;
  modelName?: string;
  /** Estimated Bedrock cost of all model calls in this run, from token usage and AWS list prices. */
  costUsd?: number;
  status: RunStatus;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  recommendation?: Recommendation;
  evidence: EvidenceItem[];
  validation: RunValidation;
  error?: string;
  decision?: DecisionRecord;
}

export type StreamEvent =
  | { type: 'run_started'; runId: string; claimId: string; modelId: string; modelName?: string; servers: { id: ServerId; label: string; endpoint: string }[] }
  | { type: 'tools_discovered'; server: ServerId; tools: string[]; latencyMs: number }
  | { type: 'model_text'; text: string; turn: number }
  | { type: 'tool_call'; toolUseId: string; evidenceId: string; server: ServerId; tool: string; args: Record<string, unknown>; turn: number }
  | { type: 'tool_result'; evidence: EvidenceItem }
  | { type: 'model_turn'; turn: number; latencyMs: number; inputTokens: number; outputTokens: number }
  | { type: 'recommendation'; recommendation: Recommendation; validation: RunValidation }
  | { type: 'run_completed'; run: RunRecord }
  | { type: 'ping'; t: number }
  | { type: 'error'; message: string };
