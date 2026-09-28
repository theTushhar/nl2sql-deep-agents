// Frozen prod envelope: zod schema + validation + safety scans.
// Shape rules:
// - requestEcho mirrors the caller metadata unchanged.
// - sql: domain-neutral string honoring the input dialect; null/blank ONLY
//   for conversational and blocked paths.
// - aiResponse: always-present, formal, proper human-readable string.
// - filteringMetadata: AST-style intent separate from the SQL text.
// - telemetry: totals + per-subagent breakdown + per-trigger tracking.
// - meta: logical names only, models, config ref. No skill versions.
// - Safety: responses never carry DB details or sensitive column detail.

import { z } from "zod";
import type { ProdEnvelope } from "./query-envelope";
import { AST_VERSION } from "../orchestration/sql-ast";

export { type ProdEnvelope } from "./query-envelope";

// v1-clean AST schema (mirrors src/orchestration/sql-ast.ts).
// Omit-when-empty on the wire: only ast_version/select/from are required.
const AstLeafSchema = z.object({
  col: z.string().min(1),
  op: z.enum(["=", "<>", ">", "<", ">=", "<=", "LIKE", "REGEXP"]),
  val: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

type AstConditionZod = z.infer<typeof AstLeafSchema> | { and: AstConditionZod[] } | { or: AstConditionZod[] } | { raw: string };
const AstConditionSchema: z.ZodType<AstConditionZod> = z.union([
  AstLeafSchema,
  z.object({ and: z.array(z.lazy((): z.ZodType<AstConditionZod> => AstConditionSchema)) }),
  z.object({ or: z.array(z.lazy((): z.ZodType<AstConditionZod> => AstConditionSchema)) }),
  z.object({ raw: z.string() }),
]);

export const AstV1CleanSchema = z.object({
  ast_version: z.literal(AST_VERSION),
  select: z
    .array(
      z.union([
        z.object({ col: z.string().min(1), as: z.string().optional(), distinct: z.boolean().optional() }),
        z.object({ count: z.string().min(1), as: z.string().optional(), distinct: z.boolean().optional() }),
      ])
    )
    .min(1),
  from: z.object({ table: z.string().min(1), as: z.string() }),
  joins: z
    .array(
      z.object({
        type: z.enum(["INNER", "LEFT", "RIGHT", "FULL"]),
        table: z.string().min(1),
        as: z.string(),
        on: z.string().min(1),
      })
    )
    .optional(),
  where: AstConditionSchema.nullable().optional(),
  group_by: z.array(z.string().min(1)).optional(),
  order_by: z.array(z.object({ col: z.string().min(1), dir: z.enum(["ASC", "DESC"]) })).optional(),
  limit: z.number().int().min(1).optional(),
});

export const ProdEnvelopeSchema = z.object({
  requestEcho: z.record(z.unknown()),
  sql: z.string().nullable(),
  dbNeutralQuery: z.string().nullable().optional(),
  ast: z.unknown().nullable().optional(),
  dialect: z.string().optional(),
  aiResponse: z.string().min(1),
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
    tokenCounts: z.record(z.object({ in: z.number(), out: z.number() })).optional(),
    cost: z.record(z.number()).optional(),
    toolTriggers: z.array(z.object({ name: z.string(), outcome: z.string() })).optional(),
    retryCounts: z.record(z.number()).optional(),
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
    modelsUsed: z.record(z.string()).optional(),
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
  kind: "success" | "blocked" | "conversational" | "error"
): EnvelopeIssue[] {
  const issues: EnvelopeIssue[] = [];
  const shape = ProdEnvelopeSchema.safeParse(envelope);
  if (!shape.success) {
    for (const err of shape.error.errors) {
      issues.push({ path: err.path.join("."), message: err.message });
    }
    return issues;
  }

  if ((kind === "blocked" || kind === "conversational") && envelope.sql !== null) {
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
    // v1-clean: AST is required on success UNLESS the caller opted out via
    // include_ast=false (echoed in requestEcho by server.ts passthrough).
    const echo = (envelope.requestEcho || {}) as Record<string, unknown>;
    const astOptOut = echo["include_ast"] === false || echo["includeAst"] === false;
    if (envelope.ast === null || envelope.ast === undefined) {
      if (!astOptOut) {
        issues.push({ path: "ast", message: "success envelopes must carry AST JSON." });
      }
    } else if (typeof envelope.ast === "object" && envelope.ast !== null) {
      // Strict v1-clean shape check (tool output is deterministic, so any
      // failure here means drift or a hand-built envelope).
      const parsed = AstV1CleanSchema.safeParse(envelope.ast);
      if (!parsed.success) {
        for (const err of parsed.error.errors) {
          issues.push({ path: `ast.${err.path.join(".")}`, message: err.message });
        }
      }
    }
  }

  const userText = `${envelope.aiResponse}\n${envelope.error || ""}`;
  for (const pattern of LEAK_PATTERNS) {
    if (userText.includes(pattern)) {
      issues.push({ path: "aiResponse/error", message: `Response leaks internals (${pattern}).` });
    }
  }
  return issues;
}
