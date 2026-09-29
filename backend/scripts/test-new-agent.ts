import "dotenv/config";
import { createDeepAgent, registerHarnessProfile } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { readModelName } from "../src/deepagents/model";
import { buildSubagents } from "../src/deepagents/subagents";
import { FinalAnswerResponse } from "../src/deepagents/schemas";
import { createAppBackend } from "../src/deepagents/backend";

registerHarnessProfile("openai", {
  excludedTools: ["read_file", "write_file", "edit_file", "ls", "glob", "grep", "execute"],
});

const COORDINATOR_SYSTEM_PROMPT = `You are the InfoQA NL-to-SQL coordinator (Deep Agents main agent).
Formal, proper tone at all times. Read-only SELECT only. Never invent tables, columns, or joins.

Workflow (delegate via the task tool, do not answer directly):
1. task(subagent_type="input-guard", description="Classify: <question>") — if intent is malicious/out_of_scope, stop and return kind=blocked.
2. task(subagent_type="query-normalizer", description="Normalize (domain-agnostic): <question>") — if conversational, stop and return kind=conversational.
3. Resolve the domain: pinned non-default domain hint wins, SKIP domain-router. Only route when hint is default/empty/unknown.
4. task(subagent_type="domain-rephraser", description includes generic canonical query + resolved domain + projection policy) — rephrase + re-review intent.
5. In parallel: task(subagent_type="schema-explorer", ...) + task(subagent_type="business-rules", ...) on the domain-canonical query + resolved domain.
5. task(subagent_type="sql-writer", description includes schema context + measures/filters/orderBy + critique if retry) then task(subagent_type="sql-critic", ...) to validate. Retry writer+critic up to 3 rounds total using the critique text.
6. On success with critic valid=true AND include_ast=true: task(subagent_type="ast-generator", description includes the certified SQL + question + dialect + domain + catalog text + required tables + search spec + filters + time context) and pass its JSON through as ast (or set astUnsupported when it returns unsupported=true). When include_ast=false, skip ast-generator and return ast=null.
7. Return the FinalAnswer JSON: kind, sql (certified candidate or null), ast (ast-generator JSON or null), domain, intent, complexity, tablesUsed, measures, filters, ordering, searchScope, warnings, unresolved.

Rules:
- Default domain may borrow multi-table schema facts but emits ONE single query, never one per domain.
- Never emit uncertified SQL as success: if critic never returns valid=true within budget, return kind=error with sql=null.
- Keep delegation descriptions self-contained (include question + domain + tables + filters); subagents are isolated and see only what you pass.`;

async function main() {
  const backend = createAppBackend();
  const agent = createDeepAgent({
    model: `openai:${readModelName()}`,
    systemPrompt: COORDINATOR_SYSTEM_PROMPT,
    subagents: buildSubagents(),
    skills: ["/skills/"],
    memory: ["./AGENTS.md"],
    backend,
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
  });

  console.log("Agent created successfully. Invoking with test query...");
  const result = await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content: [
            "NL question: give me the test set which contains less than 3 test cases",
            "dialect: mysql",
            "domain hint: all_test_sets",
            "snapshot: default-snap",
            "include_ast: true",
            "time context: Current time: 2026-09-28",
            "Run the coordinator workflow and return FinalAnswer JSON only.",
          ].join("\n"),
        },
      ],
    },
    { configurable: { thread_id: "test-run-1" } }
  );

  console.log("RESULT KEYS:", Object.keys(result));
  console.log("STRUCTURED:", (result as any).structuredResponse ?? (result as any).response);
  const msgs = (result as any).messages || [];
  console.log("MSG COUNT:", msgs.length);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    console.log(`MSG[${i}] ${m.constructor?.name || m._getType?.()}:`, JSON.stringify(m.content).slice(0, 150));
    if (m.tool_calls?.length) {
      console.log(`  TOOL CALLS:`, m.tool_calls.map((tc: any) => tc.name));
    }
  }
}

main().catch(err => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
