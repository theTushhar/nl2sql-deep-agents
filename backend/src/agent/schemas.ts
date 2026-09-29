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
// (coordinator.ts) still uses the raw schemas.
//
// HARD CONSTRAINT (OpenAI 400 invalid_function_parameters): every wrapped
// schema MUST convert to tool parameters with top-level type "object".
// Unions have no top-level type and are rejected ("got type None"), killing
// the whole request at the first model call that binds them. Keep unions in
// code-side validation only — never inside toolStrategy().

import { z } from "zod";
import { tool, toolStrategy } from "langchain";

export const CheckerSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  fix: z.string(),
  usedTables: z.array(z.string()),
});

/**
 * Planner boundary: normalize + plan in one response. The planner classifies
 * intent, resolves the domain, and grounds tables/search/rules via tools.
 */
export const PlannerSchema = z.object({
  canonical_query: z.string(),
  intent: z.enum(["filtering", "aggregation", "list", "greeting", "out_of_scope", "malicious"]),
  conversational_response: z.string().nullable(),
  domain: z.string(),
  relevantTables: z.array(z.string()),
  searchScope: z.array(z.string()),
  likePattern: z.string().nullable(),
  operator: z.enum(["LIKE", "REGEXP", "NONE"]),
  appliedRuleIds: z.array(z.string()),
  complexity: z.enum(["simple", "medium", "complex"]),
  reasoning: z.string(),
});

/**
 * Writer boundary: SQL + AST v2 JSON in one response. The AST mirrors the
 * SQL (written by the same agent), so drift between separate writer and
 * translator stages is impossible by construction. Loose object for the
 * AST half: strict QueryAstV2Schema validation stays in the coordinator.
 */
export const WriterSchema = z.object({
  query: z.string().min(1),
  ast: z.looseObject({}).catchall(z.unknown()).nullable(),
  astUnsupported: z.boolean().optional().default(false),
  tablesUsed: z.array(z.string()),
  reasoning: z.string(),
});

/** Main-agent final answer: terminal routing + certified-SQL handoff fields. */
export const FinalAnswerSchema = z.object({
  kind: z.enum(["success", "blocked", "conversational", "error"]),
  sql: z.string().nullable(),
  /** Opaque AST-tool JSON from the writer subagent (validated in code). */
  ast: z.string().nullable(),
  astUnsupported: z.boolean().optional(),
  conversationalResponse: z.string().nullable(),
  blockedMessage: z.string().nullable(),
  error: z.string().nullable(),
  domain: z.string(),
  intent: z.string(),
  complexity: z.enum(["simple", "medium", "complex"]),
  tablesUsed: z.array(z.string()),
  /** Planner rule selection, passed through for deterministic coverage checks. */
  appliedRuleIds: z.array(z.string()).optional().default([]),
  measures: z.array(z.string()),
  filters: z.array(z.string()),
  ordering: z.array(z.string()),
  searchScope: z.array(z.string()),
  warnings: z.array(z.string()),
  unresolved: z.array(z.string()),
});

export type FinalAnswer = z.infer<typeof FinalAnswerSchema>;

// Runtime variants: structured output via synthetic tool call (see header).
export const PlannerResponse = toolStrategy(PlannerSchema);
export const WriterResponse = toolStrategy(WriterSchema);
export const CheckerResponse = toolStrategy(CheckerSchema);
export const FinalAnswerResponse = toolStrategy(FinalAnswerSchema);

/**
 * Literally-named terminal tool for the coordinator. toolStrategy names its
 * synthetic tool `extract-N` (no name option exists), so a prompt saying
 * "call the FinalAnswer tool" points at a name the model never sees — the
 * observed failure is the model routing `extract-4` through the `task` tool,
 * which throws (only planner|writer are routable) and kills the request.
 * This echo tool gives the model a directly-callable `FinalAnswer` name;
 * the coordinator's extractFinalAnswerFallback recovers its args, so every
 * terminal path (synthetic tool, echo tool, or text JSON) is covered.
 */
/**
 * Tolerant input shape for the FinalAnswer echo tool. The strict
 * FinalAnswerSchema stays on the synthetic extract tool (full field
 * guidance); models routinely omit null-valued and empty-array keys at
 * call time, and a strict function schema rejects the whole call — the
 * observed 5-attempt FinalAnswer death spiral. The echo tool accepts any
 * subset; coordinator normalize + safeParse enforce the contract afterward.
 */
const TolerantFinalAnswerInput = z.object({
  kind: z.string().optional(),
  sql: z.string().nullable().optional(),
  ast: z.string().nullable().optional(),
  conversationalResponse: z.string().nullable().optional(),
  blockedMessage: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  domain: z.string().optional(),
  intent: z.string().optional(),
  complexity: z.string().optional(),
  tablesUsed: z.array(z.string()).optional(),
  appliedRuleIds: z.array(z.string()).optional(),
  measures: z.array(z.string()).optional(),
  filters: z.array(z.string()).optional(),
  ordering: z.array(z.string()).optional(),
  searchScope: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  unresolved: z.array(z.string()).optional(),
});

export const finalAnswerTool = tool(
  async (input: z.infer<typeof TolerantFinalAnswerInput>): Promise<string> =>
    JSON.stringify(input ?? null),
  {
    name: "FinalAnswer",
    description:
      "Terminal answer. Call DIRECTLY (never via task, never delegate to a subagent), then stop. Include at least kind, sql, domain, intent, complexity, tablesUsed; use null for empty text fields and [] for empty lists. The task tool accepts ONLY planner|writer.",
    schema: TolerantFinalAnswerInput,
  }
);
