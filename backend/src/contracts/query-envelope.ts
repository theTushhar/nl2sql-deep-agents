// Frozen prod envelope shape — types only, no validation logic yet.
// - Echo all request metadata back unchanged.
// - sql: domain-neutral string honoring input dialect; null/blank for conversational + blocked.
// - aiResponse: always-present human-readable string.
// - filteringMetadata: AST-style intent (measures, filters, ordering, tables, scope).
// - warnings / errors / unresolved, telemetry (incl. per-trigger tracking), meta (no skill versions).

export interface RequestEcho {
  [key: string]: unknown;
}

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
  requestEcho: RequestEcho;
  sql: string | null;
  /** Canonical DB-neutral SQL (REGEXP/LIKE-neutral logical form). */
  dbNeutralQuery: string | null;
  /**
   * Deterministic AST JSON (v1-clean, `ast_version: "0.1.0"`) for the
   * certified query. Null when `include_ast: false` skips the buildAstTool.
   * Shape: `{ ast_version, select, from, joins?, where?, group_by?,
   * order_by?, limit? }` — see `src/orchestration/sql-ast.ts`.
   */
  ast: unknown | null;
  /** Effective rendering dialect (mysql | mssql). */
  dialect: string;
  aiResponse: string;
  filteringMetadata: FilteringMetadata | null;
  warnings: string[];
  error: string | null;
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
