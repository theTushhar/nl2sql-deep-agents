import type { ProdEnvelope, LlmCallTrace } from "../contracts/query-envelope";
import type { ComposerKind } from "../orchestration/response-composer";

// Backend-compatible envelope subset (mirrors backend QueryEnvelopeResponse).
// Field names use backend snake_case so existing callers keep working.
export interface BackendCompatTrace {
  prompt: string;
  response: string;
  stage: string;
  model: string;
  latencyMs: number;
}

export interface BackendCompatData {
  message: string | null;
  sql: string | null;
  db_neutral_query?: string | null;
  dialect: string;
  reason_code?: string | null;
  meta: {
    domain: string;
    intent: string;
    complexity: string;
    tables: string[];
    unresolved?: string[];
  };
  warnings?: string[];
  ast: unknown | null;
  telemetry: {
    model: string;
    totalLatencyMs: number;
    llmTokens: { inputTokens: number; outputTokens: number; totalTokens: number };
    llmCallsCount: number;
    llmCost: number;
    llmTraces?: BackendCompatTrace[];
  };
  echo?: Record<string, unknown>;
}

export interface BackendCompatEnvelope {
  request_id: string;
  thread_id: string;
  status: "success" | "error" | "unsupported" | "clarification_required";
  data: BackendCompatData;
}

function sumTokens(envelope: ProdEnvelope): { in: number; out: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  const counts = envelope.telemetry.tokenCounts || {};
  for (const v of Object.values(counts)) {
    inputTokens += v.in || 0;
    outputTokens += v.out || 0;
  }
  return { in: inputTokens, out: outputTokens };
}

function sumCost(envelope: ProdEnvelope): number {
  let cost = 0;
  for (const v of Object.values(envelope.telemetry.cost || {})) cost += v || 0;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function toBackendEnvelope(args: {
  envelope: ProdEnvelope;
  kind: ComposerKind;
  requestId: string;
  threadId: string;
  latencyMs: number;
  includeTraces?: boolean;
}): { payload: BackendCompatEnvelope; statusCode: number } {
  const { envelope, kind, requestId, threadId, latencyMs, includeTraces } = args;
  // NOTE: kind drives status only (conversational is success-shaped by contract).
  // Unsupported is explicit (never a weakened success): status "unsupported", HTTP 422.
  // Clarification is explicit: status "clarification_required", HTTP 200, ast null.
  const isUnsupported = kind === "unsupported";
  const isClarification = kind === "clarification_required";
  const isError = kind === "blocked" || kind === "error";

  const tokens = sumTokens(envelope);
  const cost = sumCost(envelope);
  const modelsUsed = Object.values(envelope.meta.modelsUsed || {});
  const model = modelsUsed[0] || "gpt-4o-mini";

  const tables = envelope.meta.tablesUsed || [];

  const rawTraces = envelope.telemetry.llmTraces || [];
  const llmTraces: BackendCompatTrace[] | undefined = includeTraces
    ? rawTraces.map((t: LlmCallTrace) => ({
        prompt: t.prompt,
        response: t.response,
        stage: t.name,
        model: t.model,
        latencyMs: t.latencyMs,
      }))
    : undefined;

  // Filter out redundant echo mirrors of top-level fields (requestId, threadId, domain, dialect)
  const customEcho: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope.requestEcho || {})) {
    if (!["requestid", "threadid", "domain", "dialect"].includes(k.toLowerCase())) {
      customEcho[k] = v;
    }
  }
  const hasCustomEcho = Object.keys(customEcho).length > 0;

  const data: BackendCompatData = {
    message: envelope.aiResponse,
    sql: envelope.sql,
    // Only include db_neutral_query when it differs from sql to avoid duplication
    ...(envelope.dbNeutralQuery && envelope.dbNeutralQuery !== envelope.sql
      ? { db_neutral_query: envelope.dbNeutralQuery }
      : {}),
    dialect: envelope.dialect || "mysql",
    ...(envelope.reasonCode ? { reason_code: envelope.reasonCode } : {}),
    meta: {
      domain: envelope.meta.domain || "default",
      intent: envelope.meta.intent || "query_data",
      complexity: envelope.meta.complexity || "simple",
      tables,
      ...(envelope.unresolved && envelope.unresolved.length > 0 ? { unresolved: envelope.unresolved } : {}),
    },
    ...(envelope.warnings && envelope.warnings.length > 0 ? { warnings: envelope.warnings } : {}),
    ast: envelope.ast ?? null,
    telemetry: {
      model,
      totalLatencyMs: latencyMs,
      llmTokens: {
        inputTokens: tokens.in,
        outputTokens: tokens.out,
        totalTokens: tokens.in + tokens.out,
      },
      // Actual LLM call count (one record per chat completion, including
      // writer/critic retries). Falls back to stage count when empty.
      llmCallsCount: rawTraces.length || Object.keys(envelope.meta.modelsUsed || {}).length,
      llmCost: cost,
      ...(llmTraces ? { llmTraces } : {}),
    },
    ...(hasCustomEcho ? { echo: customEcho } : {}),
  };

  if (isUnsupported) {
    return {
      payload: { request_id: requestId, thread_id: threadId, status: "unsupported", data },
      statusCode: 422,
    };
  }
  if (isClarification) {
    return {
      payload: { request_id: requestId, thread_id: threadId, status: "clarification_required", data },
      statusCode: 200,
    };
  }
  return {
    payload: { request_id: requestId, thread_id: threadId, status: isError ? "error" : "success", data },
    statusCode: isError ? 400 : 200,
  };
}
