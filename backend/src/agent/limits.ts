// Per-agent LLM call budgets (built-in modelCallLimitMiddleware).
// Each agent — the coordinator and every subagent — gets its own runLimit:
// the Nth model call within a single task invocation throws
// ModelCallLimitMiddlewareError and stops that agent. Counts are per run
// (middleware state), so concurrent requests never share a budget.
//
// Assignability (highest precedence first):
//   LLM_CALL_LIMIT_<AGENT>  e.g. LLM_CALL_LIMIT_SQL_WRITER=5
//   AGENT_LLM_CALL_LIMIT    global default for all agents
//   code fallback           3 for subagents, 8 for the coordinator
//
// The coordinator needs ~4-5 model calls per request (planner task +
// writer task + FinalAnswer + headroom), so capping it at 3
// would break every request. 8 bounds retry storms while leaving headroom.
// Subagents do their whole job in 1–2 calls; 3 leaves one retry.

import { modelCallLimitMiddleware } from "langchain";
import type { AgentMiddleware } from "langchain";

export const DEFAULT_SUBAGENT_LLM_CALL_LIMIT = 3;
export const DEFAULT_COORDINATOR_LLM_CALL_LIMIT = 8;

/** Resolve the runLimit for one agent (kebab-case name, e.g. "writer"). */
export function llmCallLimitFor(agentName: string, fallback: number): number {
  const specific = Number(
    process.env[`LLM_CALL_LIMIT_${agentName.toUpperCase().replace(/-/g, "_")}`]
  );
  if (Number.isFinite(specific) && specific > 0) return Math.floor(specific);
  const global = Number(process.env.AGENT_LLM_CALL_LIMIT);
  if (Number.isFinite(global) && global > 0) return Math.floor(global);
  return fallback;
}

/**
 * Budget middleware for one agent: at most `runLimit` model calls per task
 * invocation, then fail fast with an error (never loop, never hang).
 */
export function createLlmCallLimit(agentName: string, fallback: number): AgentMiddleware {
  return modelCallLimitMiddleware({
    runLimit: llmCallLimitFor(agentName, fallback),
    exitBehavior: "error",
  }) as unknown as AgentMiddleware;
}
