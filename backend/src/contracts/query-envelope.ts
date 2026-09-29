// Frozen prod envelope shape — types only, no validation logic yet.
// - sql: domain-neutral string honoring input dialect; null/blank for conversational + blocked.
// - aiResponse: always-present human-readable string.
// - filteringMetadata: AST-style intent (measures, filters, ordering, tables, scope).
// - warnings / errors / unresolved, telemetry (incl. per-trigger tracking), meta (no skill versions).

export interface FilteringMetadata {
  measures?: string[];
  filters?: unknown[];
  ordering?: unknown[];
  tables?: string[];
  scope?: string;
}

export interface LlmCallTrace {
  name: string;
  model: string;
  prompt: string;
  response: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  live: boolean;
}

export interface Telemetry {
  latencyMs?: number;
  tokenCounts?: Record<string, { in: number; out: number }>;
  cost?: Record<string, number>;
  toolTriggers?: Array<{ name: string; outcome: string }>;
  retryCounts?: Record<string, number>;
  traceId?: string;
  /** Per-LLM-call records in pipeline execution order. */
  llmTraces?: LlmCallTrace[];
}

export interface ProdEnvelope {
  sql: string | null;
  /** Canonical DB-neutral SQL (portable LIKE form). */
  dbNeutralQuery: string | null;
  /**
   * AST v2 JSON (version "2.0") derived from the certified SQL by the
   * writer subagent. Null on unsupported / clarification / include_ast=false.
   * Never a weakened AST.
   * Shape: `{ version, root, projection, joins?, where?, groupBy?, having?,
   * orderBy?, limit? }` — see `src/contracts/query-ast-v2.ts`.
   */
  ast: unknown | null;
  /** Effective rendering dialect (mysql | mssql). */
  dialect: string;
  aiResponse: string;
  filteringMetadata: FilteringMetadata | null;
  warnings: string[];
  error: string | null;
  /** Machine reason code for unsupported / clarification (e.g. UNSUPPORTED_OPERATION). Null on success. */
  reasonCode: string | null;
  unresolved: string[];
  telemetry: Telemetry;
  meta: {
    domain?: string;
    intent?: string;
    complexity?: string;
    tablesUsed?: string[];
    modelsUsed?: Record<string, string>;
    configSnapshotRef?: string;
  };
}
