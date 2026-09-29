// Frozen prod envelope: zod schema + validation + safety scans.
// Shape rules:
// - requestEcho mirrors the caller metadata unchanged.
// - sql: rendered dialect SQL; dbNeutralQuery: canonical neutral SQL.
//   Null/blank ONLY for conversational, blocked, error, clarification.
//   Unsupported keeps certified SQL + ast:null + reasonCode.
// - aiResponse: always-present, formal, proper human-readable string.
// - reasonCode: required on unsupported / clarification_required.
// - ast: strict v2 only (version "2.0"); v1-clean no longer accepted.
// - filteringMetadata, telemetry, meta as before. No skill versions.
// - Safety: responses never carry DB details or sensitive column detail.

import { z } from "zod";
import type { ProdEnvelope } from "./query-envelope";
import { QueryAstV2Schema } from "./query-ast-v2";

export { type ProdEnvelope } from "./query-envelope";

// v2-only AST: strict contract, no v1 fallback, no raw escape hatch.
export const AstV2StrictSchema = QueryAstV2Schema;

export const ProdEnvelopeSchema = z.object({
  requestEcho: z.record(z.string(), z.unknown()),
  sql: z.string().nullable(),
  dbNeutralQuery: z.string().nullable().optional(),
  ast: z.unknown().nullable().optional(),
  dialect: z.string().optional(),
  aiResponse: z.string().min(1),
  reasonCode: z.string().nullable().optional(),
  filteringMetadata: z
    .object({
      measures: z.array(z.string()).optional(),
      filters: z.array(z.unknown()).optional(),
      ordering: z.array(z.unknown()).optional(),
      tables: z.array(z.string()).optional(),
      scope: z.string().optional(),
    })
    .nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  unresolved: z.array(z.string()),
  telemetry: z.object({
    latencyMs: z.number().optional(),
    tokenCounts: z.record(z.string(), z.object({ in: z.number(), out: z.number() })).optional(),
    cost: z.record(z.string(), z.number()).optional(),
    toolTriggers: z.array(z.object({ name: z.string(), outcome: z.string() })).optional(),
    retryCounts: z.record(z.string(), z.number()).optional(),
    traceId: z.string().optional(),
    llmTraces: z
      .array(
        z.object({
          name: z.string(),
          model: z.string(),
          prompt: z.string(),
          response: z.string(),
          latencyMs: z.number(),
          promptTokens: z.number(),
          completionTokens: z.number(),
          totalTokens: z.number(),
          live: z.boolean(),
        })
      )
      .optional(),
  }),
  meta: z.object({
    domain: z.string().optional(),
    intent: z.string().optional(),
    complexity: z.string().optional(),
    tablesUsed: z.array(z.string()).optional(),
    modelsUsed: z.record(z.string(), z.string()).optional(),
    configSnapshotRef: z.string().optional(),
  }),
});

/** Substrings that must never appear in user-facing text (DB internals). */
const LEAK_PATTERNS = [
  "INFORMATION_SCHEMA",
  "information_schema",
  "pg_catalog",
  "sqlite_master",
  "connection string",
  "connectionString",
  "password",
  "secret key",
  "secretkey",
];

export interface EnvelopeIssue {
  path: string;
  message: string;
}

/** Full freeze validation: shape + null-SQL rules + leak scan. */
export function validateEnvelope(
  envelope: ProdEnvelope,
  kind: "success" | "blocked" | "conversational" | "error" | "unsupported" | "clarification_required"
): EnvelopeIssue[] {
  const issues: EnvelopeIssue[] = [];
  const shape = ProdEnvelopeSchema.safeParse(envelope);
  if (!shape.success) {
    for (const err of shape.error.issues) {
      issues.push({ path: err.path.join("."), message: err.message });
    }
    return issues;
  }

  if ((kind === "blocked" || kind === "conversational" || kind === "clarification_required") && envelope.sql !== null) {
    issues.push({ path: "sql", message: `${kind} envelopes must carry null SQL.` });
  }
  // P2-3: simplified redundant condition (was kind===success||error && kind===success).
  if (kind === "success") {
    if (envelope.sql === null || envelope.sql.trim() === "") {
      issues.push({ path: "sql", message: "success envelopes must carry certified SQL." });
    }
    if (envelope.dbNeutralQuery === null || (typeof envelope.dbNeutralQuery === "string" && envelope.dbNeutralQuery.trim() === "")) {
      issues.push({ path: "dbNeutralQuery", message: "success envelopes must carry DB-neutral SQL." });
    }
    // AST is required on success UNLESS the caller opted out via
    // include_ast=false (echoed in requestEcho by server.ts passthrough) or
    // the AST tool failed while certified SQL stands (AST_VALIDATION_FAILED
    // marker in unresolved — SQL success with ast:null, never weakened AST).
    const echo = (envelope.requestEcho || {}) as Record<string, unknown>;
    const astOptOut = echo["include_ast"] === false;
    const astToolFailed = (envelope.unresolved || []).some((u) => String(u).includes("AST_VALIDATION_FAILED"));
    if (envelope.ast === null || envelope.ast === undefined) {
      if (!astOptOut && !astToolFailed) {
        issues.push({ path: "ast", message: "success envelopes must carry AST JSON." });
      }
    } else if (typeof envelope.ast === "object" && envelope.ast !== null) {
      // Strict v2-only: any AST object must parse as QueryAstV2.
      const parsed = QueryAstV2Schema.safeParse(envelope.ast);
      if (!parsed.success) {
        for (const err of parsed.error.issues) {
          issues.push({ path: `ast.${err.path.join(".")}`, message: err.message });
        }
      }
    }
  }
  if (kind === "unsupported" && envelope.ast !== null) {
    issues.push({ path: "ast", message: "unsupported envelopes must carry ast:null." });
  }
  if ((kind === "unsupported" || kind === "clarification_required") && !envelope.reasonCode) {
    issues.push({ path: "reasonCode", message: `${kind} envelopes must carry reasonCode.` });
  }
  if (kind === "clarification_required" && envelope.ast !== null) {
    issues.push({ path: "ast", message: "clarification_required envelopes must carry ast:null." });
  }

  const userText = `${envelope.aiResponse}\n${envelope.error || ""}`;
  for (const pattern of LEAK_PATTERNS) {
    if (userText.includes(pattern)) {
      issues.push({ path: "aiResponse/error", message: `Response leaks internals (${pattern}).` });
    }
  }
  return issues;
}
