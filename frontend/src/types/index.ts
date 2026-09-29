export interface LlmTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Mirrors backend BackendCompatTrace: one record per LLM call. */
export interface LlmTrace {
  prompt: string;
  response: string;
  /** Pipeline stage name (e.g. sql-writer, sql-critic). */
  stage?: string;
  model?: string;
  latencyMs?: number;
}

/** Mirrors backend BackendCompatData.telemetry. */
export interface Telemetry {
  /** Primary model used (first of meta.modelsUsed, fallback gpt-4o-mini). */
  model?: string;
  totalLatencyMs?: number;
  llmTokens?: LlmTokens;
  llmCallsCount?: number;
  llmCost?: number;
  /** Only present when include_traces=true was sent. */
  llmTraces?: LlmTrace[];
}

export interface QueryMeta {
  domain?: string;
  intent?: string;
  complexity?: string;
  tables?: string[];
  unresolved?: string[];
}

/**
 * Mirrors backend BackendCompatEnvelope.
 * status="error" with sql=null/ast=null covers blocked + error kinds
 * (HTTP 400). Conversational turns are status="success" with sql=null.
 */
export interface QueryResult {
  requestId?: string;
  threadId?: string;
  status?: "success" | "error" | "unsupported";
  /** HTTP status code of the /api/query response (200 | 400 | 500). */
  statusCode?: number;
  /** Human-readable answer / status message (data.message). */
  message?: string | null;
  sql?: string | null;
  dbNeutralQuery?: string | null;
  dialect?: string;
  warnings?: string[];
  ast?: unknown | null;
  meta?: QueryMeta;
  telemetry?: Telemetry;
  /** Verbatim caller passthrough fields echoed by the backend. */
  echo?: Record<string, unknown>;
  /** Transport-level error (validation 400 / 500 shapes only). Never set from warnings. */
  error?: string;
}

export interface DevSqlResult {
  success: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  dbLatencyMs?: number;
  error?: string;
}

export interface Message {
  id: string;
  type: "user" | "system" | "error";
  content: React.ReactNode;
  timestamp: number;
}
