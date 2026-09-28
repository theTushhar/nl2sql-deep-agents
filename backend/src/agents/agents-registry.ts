// Agent registry — one entry per scoped pipeline agent.
// Each: exclusive tools, bounded retries, full trace span, generic LLM model.
export const AGENTS = [
  "input-guard",
  "query-normalizer",
  "domain-router",
  "schema-explorer",
  "business-rules",
  "sql-writer",
  "sql-critic",
  "response-composer",
] as const;

export type AgentName = (typeof AGENTS)[number];

/** @deprecated Use AGENTS. Kept for backward-compatible imports. */
export const SUBAGENTS = AGENTS;
/** @deprecated Use AgentName. */
export type SubagentName = AgentName;

export { analyzeGuardrail } from "./input-guard.agent";
export type { GuardrailInput, GuardrailOutput, GuardrailVerdict, GuardrailIntent } from "./input-guard.agent";
export { normalizeQuery } from "./query-normalizer.agent";
export type { DebuggerInput, DebuggerOutput } from "./query-normalizer.agent";
export { routeDomain } from "./domain-router.agent";
export type { RouterInput, RouterOutput } from "./domain-router.agent";
export { exploreSchema } from "./schema-explorer.agent";
export type { ExplorerInput, ExplorerOutput } from "./schema-explorer.agent";
export { interpretRules } from "./business-rules.agent";
export type { InterpreterInput, InterpreterOutput } from "./business-rules.agent";
export { writeSql } from "./sql-writer.agent";
export type { WriterInput, WriterOutput } from "./sql-writer.agent";
export { critiqueSql } from "./sql-critic.agent";
export type { CriticInput, CriticOutput } from "./sql-critic.agent";
export { composeResponse } from "./response-composer";
export type { ComposerInput, ComposerKind, StageRecord } from "./response-composer";
