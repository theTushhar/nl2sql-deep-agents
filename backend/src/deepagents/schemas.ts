// Deep Agents responseFormat schemas (zod v4).
// Each subagent returns JSON matching one of these — the parent receives
// parsed JSON instead of free text, replacing hand-rolled extractJson +
// STRICT-JSON-in-prompt boilerplate.
//
// IMPORTANT: the runtime MUST use the toolStrategy-wrapped variants
// (*Response below), never the raw schemas. Raw zod goes through the
// provider-native json_schema response_format, which routes the OpenAI SDK
// through completions.parse() — and parse() throws unless EVERY bound tool
// is strict:true (DeepAgents' built-in filesystem tools are not). The
// toolStrategy variants deliver the final answer as a synthetic tool call,
// so requests stay on the lax .create() path. Code-side validation
// (coordinator-deep.ts) still uses the raw schemas.
//
// HARD CONSTRAINT (OpenAI 400 invalid_function_parameters): every wrapped
// schema MUST convert to tool parameters with top-level type "object".
// Unions have no top-level type and are rejected ("got type None"), killing
// the whole request at the first model call that binds them. Keep unions in
// code-side validation only — never inside toolStrategy().

import { z } from "zod";
import { toolStrategy } from "langchain";

export const GuardrailSchema = z.object({
  is_valid: z.boolean(),
  intent_type: z.enum(["query_data", "general_chitchat", "out_of_scope", "malicious"]),
  confidence: z.number().min(0).max(1),
  flags: z.array(z.string()),
  rejection_reason: z.string().nullable(),
});

export const NormalizerSchema = z.object({
  intent: z.string(),
  // Domain-agnostic normalizer: domain resolution happens later (pinned
  // request domain wins, otherwise domain-router decides). Kept as an
  // optional passthrough so older outputs still validate; new prompts omit it.
  domain: z.string().optional().default("undecided"),
  canonical_query: z.string(),
  conversational_response: z.string().nullable(),
  extracted_entities: z.array(z.string()),
  detected_temporal_phrases: z.array(z.string()),
});

export const RouterSchema = z.object({
  domain_key: z.string(),
  sub_domain_key: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const RephraserSchema = z.object({
  domain_canonical_query: z.string().min(1),
  intent: z.enum(["aggregation", "filtering", "list"]),
  complexity: z.enum(["simple", "medium", "complex"]),
  reasoning: z.string(),
});

export const ExplorerSchema = z.object({
  relevantTables: z.array(z.string()),
  searchScope: z.array(z.string()),
  likePattern: z.string().nullable(),
  operator: z.enum(["LIKE", "REGEXP", "NONE"]),
  complexity: z.enum(["simple", "medium", "complex"]),
  reasoning: z.string(),
});

export const InterpreterSchema = z.object({
  appliedRuleIds: z.array(z.string()),
  orderBy: z.array(z.string()),
  measures: z.array(z.string()),
  dimensions: z.array(z.string()),
  reasoning: z.string(),
});

export const WriterSchema = z.object({
  query: z.string().min(1),
});

export const CriticSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  critique: z.string(),
  unresolved: z.array(z.string()),
  usedTables: z.array(z.string()),
});

export const AstUnsupportedSchema = z.object({
  unsupported: z.literal(true),
  reason_code: z.string(),
});

/**
 * AST subagent boundary schema — intentionally loose.
 * Strict structured-output providers reject recursive schemas (the full v2
 * predicate tree uses z.lazy), so the boundary accepts any v2-shaped object
 * and coordinator-deep.ts re-validates strictly with QueryAstV2Schema +
 * catalog/limits/aggregates/SQL-agreement checks in code.
 */
export const AstResponseSchema = z.union([
  AstUnsupportedSchema,
  z.object({ version: z.literal("2.0") }).passthrough(),
]);

/**
 * Runtime boundary for the ast-generator subagent. MUST stay a top-level
 * object schema: the union above converts to `{anyOf: [...]}` with no
 * `type`, and OpenAI rejects the whole model call with 400
 * invalid_function_parameters ("got type None") — observed in production as
 * `Invalid schema for function 'extract-N'`. Loose object preserves the full
 * AST JSON for code-side validation; both union members are objects, so
 * nothing valid is lost by widening here.
 */
const AstResponseBoundary = z.looseObject({}).catchall(z.unknown());

/** Main-agent final answer: terminal routing + certified-SQL handoff fields. */
export const FinalAnswerSchema = z.object({
  kind: z.enum(["success", "blocked", "conversational", "error"]),
  sql: z.string().nullable(),
  /** Opaque AST-tool JSON from the ast-generator subagent (validated in code). */
  ast: z.string().nullable(),
  astUnsupported: z.boolean().optional(),
  conversationalResponse: z.string().nullable(),
  blockedMessage: z.string().nullable(),
  error: z.string().nullable(),
  domain: z.string(),
  intent: z.string(),
  complexity: z.enum(["simple", "medium", "complex"]),
  tablesUsed: z.array(z.string()),
  measures: z.array(z.string()),
  filters: z.array(z.string()),
  ordering: z.array(z.string()),
  searchScope: z.array(z.string()),
  warnings: z.array(z.string()),
  unresolved: z.array(z.string()),
});

export type FinalAnswer = z.infer<typeof FinalAnswerSchema>;

// Runtime variants: structured output via synthetic tool call (see header).
export const GuardrailResponse = toolStrategy(GuardrailSchema);
export const NormalizerResponse = toolStrategy(NormalizerSchema);
export const RouterResponse = toolStrategy(RouterSchema);
export const RephraserResponse = toolStrategy(RephraserSchema);
export const ExplorerResponse = toolStrategy(ExplorerSchema);
export const InterpreterResponse = toolStrategy(InterpreterSchema);
export const WriterResponse = toolStrategy(WriterSchema);
export const CriticResponse = toolStrategy(CriticSchema);
export const AstResponse = toolStrategy(AstResponseBoundary);
export const FinalAnswerResponse = toolStrategy(FinalAnswerSchema);
