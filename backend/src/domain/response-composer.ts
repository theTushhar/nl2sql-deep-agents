// Response composer (deterministic envelope assembly).
// PURE composition: no tools, no LLM calls. Assembles the frozen envelope
// from certified or terminal upstream state. Formal, proper tone on every
// path. SQL byte-identity holds by construction: the certified string is
// assigned by reference, never rewritten.

import type { ProdEnvelope, LlmCallTrace } from "../contracts/query-envelope";

export type ComposerKind = "success" | "blocked" | "conversational" | "error" | "unsupported" | "clarification_required";

export interface StageRecord {
  model: string;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ComposerInput {
  kind: ComposerKind;
  dialect: string;
  /** Byte-identical certified SQL. Only set for kind=success. */
  certifiedSql: string | null;
  /** Canonical DB-neutral SQL (rendered per dialect into certifiedSql). */
  dbNeutralQuery?: string | null;
  /** Deterministic AST JSON for the certified query. */
  ast?: unknown | null;
  /** Opaque certification detail (kept for forward-compat; never read). */
  cert: unknown | null;
  conversationalResponse: string | null;
  blockedMessage: string | null;
  error: string | null;
  /** Machine reason code for unsupported / clarification (e.g. UNSUPPORTED_OPERATION). */
  reasonCode?: string | null;
  warnings: string[];
  unresolved: string[];
  filteringMetadata: ProdEnvelope["filteringMetadata"];
  domain: string;
  intent: string;
  complexity: string;
  tablesUsed: string[];
  stages: Record<string, StageRecord>;
  triggers: Array<{ name: string; outcome: string }>;
  retryCounts: Record<string, number>;
  traceId: string;
  latencyMs: number;
  configSnapshotRef: string;
  modelsLive: boolean;
  /** Per-LLM-call records (optional so unit callers need not supply them). */
  llmTraces?: LlmCallTrace[];
  question?: string;
  canonical_query?: string;
}

const GENERIC_BLOCKED =
  "Your request cannot be processed as stated. Please rephrase it as a data question about your test sets, test cases, or test runs, avoiding any system or destructive instructions.";

const EXHAUSTED_MESSAGE =
  "Your request could not be converted into a certified query after repeated attempts. Please rephrase your question with additional detail about the test sets, test cases, or test runs you need, and try again.";

function intentPhrase(intent: string): string {
  if (intent === "aggregation") return "It returns an aggregation";
  if (intent === "list") return "It returns a list";
  return "It returns a filtered result";
}

const UNSUPPORTED_MESSAGE =
  "This search cannot be represented by the supported query contract.";

export function composeResponse(input: ComposerInput): ProdEnvelope {
  if (input.kind === "success" &&
      (input.certifiedSql === null || input.certifiedSql.trim() === "") &&
      (input.ast === null || input.ast === undefined)) {
    throw new Error("Composer invariant violated: success requires SQL or AST output.");
  }
  // Unsupported keeps certified SQL for migration but carries ast:null and a
  // reason — never a weakened AST. Clarification carries null SQL + prompt.
  // All other non-success kinds carry null SQL.
  if (
    (input.kind === "blocked" ||
      input.kind === "conversational" ||
      input.kind === "error" ||
      input.kind === "clarification_required") &&
    input.certifiedSql !== null
  ) {
    throw new Error("Composer invariant violated: non-success kinds must carry null SQL.");
  }

  const tokenCounts: Record<string, { in: number; out: number }> = {};
  const cost: Record<string, number> = {};
  const modelsUsed: Record<string, string> = {};
  for (const [stage, rec] of Object.entries(input.stages)) {
    tokenCounts[stage] = { in: rec.tokensIn, out: rec.tokensOut };
    cost[stage] = Math.round(rec.costUsd * 1_000_000) / 1_000_000;
    modelsUsed[stage] = rec.model;
  }

  let aiResponse: string;
  if (input.kind === "conversational") {
    aiResponse =
      input.conversationalResponse ||
      "Hello. I am your InfoQA data assistant. Please ask a data question about your test sets, test cases, or test runs.";
  } else if (input.kind === "blocked") {
    aiResponse = input.blockedMessage || GENERIC_BLOCKED;
  } else if (input.kind === "error") {
    aiResponse = EXHAUSTED_MESSAGE;
  } else if (input.kind === "unsupported") {
    aiResponse = UNSUPPORTED_MESSAGE;
  } else if (input.kind === "clarification_required") {
    aiResponse =
      input.conversationalResponse ||
      "Your request is ambiguous. Please specify which test sets, test cases, or date range you mean, and try again.";
  } else {
    const tableWord = input.tablesUsed.length === 1 ? "table" : "tables";
    const tablesStr = input.tablesUsed.length > 0 ? input.tablesUsed.join(", ") : "the requested data";

    let filterDetails = "";
    if (input.filteringMetadata?.filters && input.filteringMetadata.filters.length > 0) {
      const activeRules = input.filteringMetadata.filters.map(String);
      const isPersonal = activeRules.some((r) => r.includes("Personal"));
      if (isPersonal) {
        filterDetails = " for your personal test suites";
      }
    }

    if (input.question) {
      aiResponse =
        `Here is your certified query for "${input.question}". ` +
        `It retrieves filtered results${filterDetails} from ${tablesStr}.`;
    } else {
      aiResponse =
        `Your query has been prepared and certified for the ${input.dialect} dialect. ` +
        `${intentPhrase(input.intent)} across ${input.tablesUsed.length} ${tableWord} (${tablesStr}).`;
    }
  }

  return {
    sql: input.certifiedSql,
    dbNeutralQuery:
      input.kind === "success" || input.kind === "unsupported"
        ? (input.dbNeutralQuery ?? input.certifiedSql)
        : null,
    ast: input.kind === "success" ? (input.ast ?? null) : null,
    dialect: input.dialect,
    aiResponse,
    filteringMetadata: input.filteringMetadata,
    warnings: [...input.warnings],
    error: input.error,
    reasonCode:
      input.kind === "unsupported" || input.kind === "clarification_required"
        ? (input.reasonCode ?? (input.kind === "unsupported" ? "UNSUPPORTED_OPERATION" : "CLARIFICATION_REQUIRED"))
        : null,
    unresolved: [...input.unresolved],
    telemetry: {
      latencyMs: input.latencyMs,
      tokenCounts,
      cost,
      toolTriggers: input.triggers.map((t) => ({ ...t })),
      retryCounts: { ...input.retryCounts },
      traceId: input.traceId,
      llmTraces: input.llmTraces ? [...input.llmTraces] : [],
    },
    meta: {
      domain: input.domain,
      intent: input.intent,
      complexity: input.complexity,
      tablesUsed: [...input.tablesUsed],
      modelsUsed,
      configSnapshotRef: input.configSnapshotRef,
    },
  };
}
