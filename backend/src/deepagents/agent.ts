// Deep Agents runtime singleton.
// One createDeepAgent with: systemPrompt (coordinator), memory (AGENTS.md),
// skills (./skills/), subagents (pipeline stages), FilesystemBackend,
// MemorySaver checkpointer. Prompts stay in prompts/*.prompt.md; skills stay
// in skills/*/SKILL.md — this file only wires them.

import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { resolveModelId } from "./model";
import { buildSubagents } from "./subagents";
import { FinalAnswerResponse } from "./schemas";
import { createAppBackend } from "./backend";
import { createLlmCallLimit, DEFAULT_COORDINATOR_LLM_CALL_LIMIT } from "./limits";

const COORDINATOR_SYSTEM_PROMPT = `You are the InfoQA NL-to-SQL coordinator (Deep Agents main agent).
Formal, proper tone at all times. Read-only SELECT only. Never invent tables, columns, or joins.

Workflow (delegate via the task tool, do not answer directly):
1. task(subagent_type="input-guard", description="Classify: <question>") — if intent is malicious/out_of_scope, stop and return kind=blocked.
2. task(subagent_type="query-normalizer", description="Normalize (domain-agnostic): <question>") — if conversational, stop and return kind=conversational. Ignore any domain guess here; it is never authoritative.
3. Resolve the domain: if the request "domain hint" names a registered non-default domain, PIN it and SKIP domain-router entirely. Only when the hint is "default" (or empty/unknown) call task(subagent_type="domain-router", description="Route: <canonical query>") — one domain only.
4. task(subagent_type="domain-rephraser", description includes the generic canonical query + resolved domain + its projection policy) — rephrases into a domain-canonical query and re-reviews intent/complexity under that domain's contract. The resolved domain is authoritative and never changes here.
5. In parallel: task(subagent_type="schema-explorer", ...) + task(subagent_type="business-rules", ...) on the domain-canonical query + resolved domain.
6. task(subagent_type="sql-writer", description includes schema context + measures/filters/orderBy + critique if retry) then task(subagent_type="sql-critic", ...) to validate. Retry writer+critic up to 3 rounds total using the critique text.
7. On success with critic valid=true AND include_ast=true: task(subagent_type="ast-generator", description includes the certified SQL + question + dialect + domain + catalog text + required tables + search spec + filters + time context) and pass its JSON through as ast (or set astUnsupported when it returns unsupported=true). When include_ast=false, skip ast-generator and return ast=null.
8. Return the FinalAnswer JSON: kind, sql (certified candidate or null), ast (ast-generator JSON or null), domain (the RESOLVED domain), intent (the RE-REVIEWED intent), complexity, tablesUsed, measures, filters, ordering, searchScope, warnings, unresolved.

Rules:
- Pinned request domains always win: never let domain-router or the normalizer override them.
- Default domain may borrow multi-table schema facts but emits ONE single query, never one per domain.
- Never emit uncertified SQL as success: if critic never returns valid=true within budget, return kind=error with sql=null.
- Downstream stages (explorer, business-rules, writer) always use the domain-canonical query, never the generic one.
- Keep delegation descriptions self-contained (include question + domain + tables + filters); subagents are isolated and see only what you pass.`;

let cached: Awaited<ReturnType<typeof createDeepAgent>> | null = null;

export async function getDeepAgent(): Promise<NonNullable<typeof cached>> {
  if (cached) return cached;
  const backend = createAppBackend();
  const params = {
    model: resolveModelId(),
    systemPrompt: COORDINATOR_SYSTEM_PROMPT,
    subagents: buildSubagents(),
    skills: ["/skills/"],
    memory: ["./AGENTS.md"],
    backend,
    // Read-only filesystem: the agent needs read_file for skill L2 reads;
    // every other built-in file tool (glob/ls/grep/write/edit) is dropped.
    // (Also works around OpenAI strict-schema rejection of `glob`.)
    // Same-name middleware REPLACES the default FilesystemMiddleware.
    // Call budget: the coordinator needs ~10 model calls per request (one
    // per delegation step), capped here instead of looping forever. Tunable
    // via LLM_CALL_LIMIT_COORDINATOR / AGENT_LLM_CALL_LIMIT (see limits.ts).
    middleware: [
      createFilesystemMiddleware({ backend, tools: ["read_file"] }),
      createLlmCallLimit("coordinator", DEFAULT_COORDINATOR_LLM_CALL_LIMIT),
    ],
    // Least privilege (inherited by all subagents): no writes anywhere, no
    // reads of secrets/deps/build output. Secrets stay out of model context.
    permissions: [
      { operations: ["write"], paths: ["/**"], mode: "deny" },
      {
        operations: ["read"],
        paths: ["/.env", "/.env.*", "/node_modules/**", "/dist/**"],
        mode: "deny",
      },
    ],
    checkpointer: new MemorySaver(),
    responseFormat: FinalAnswerResponse,
  } as unknown as Parameters<typeof createDeepAgent>[0];
  const agent = await createDeepAgent(params);
  cached = agent as NonNullable<typeof cached>;
  return cached;
}

/** For tests: reset the singleton so config changes take effect. */
export function resetDeepAgent(): void {
  cached = null;
}
