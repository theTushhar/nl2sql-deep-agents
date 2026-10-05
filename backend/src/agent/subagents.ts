// Pipeline stages. Wording lives in prompts/<name>.prompt.md (loaded with the
// shared safety footer); `description` stays in code per the SubAgent spec —
// the coordinator uses it for delegation routing. `model` is omitted so all
// stages inherit the single LLM_MODEL. Skills are per-subagent (no inheritance).
// NOTE: the LLM checker subagent was retired (it rejected valid GROUP BY /
// HAVING and approved degraded retries). Safety is enforced deterministically
// in code by runStaticChecks + plan gates in coordinator.ts, which are
// authoritative. prompts/checker.prompt.md is kept for history only.
import type { SubAgent } from "deepagents";
import { createFilesystemMiddleware } from "deepagents";
import { loadStagePrompt } from "./prompts";
import { snapshotTools } from "./tools";
import { createAppBackend } from "./backend";
import { createLlmCallLimit, DEFAULT_SUBAGENT_LLM_CALL_LIMIT } from "./limits";
import {
  PlannerResponse,
  WriterResponse,
} from "./schemas";

function toolNames(names: string[]) {
  return snapshotTools.filter((t) => names.includes((t as { name: string }).name));
}

function readOnlyFs() {
  return createFilesystemMiddleware({ backend: createAppBackend(), tools: ["read_file"] });
}

export function buildSubagents(): SubAgent[] {
  const subs: SubAgent[] = [
    {
      name: "planner",
      description:
        "Normalize the user question then plan tables, text-search scope, and business rules. Call first on every request.",
      systemPrompt: loadStagePrompt("planner"),
      // P0-2: domain/tables are pre-resolved deterministically in coordinator
      // invokeInput (domain hint + effectiveTables gate) — the planner must use
      // the pinned hint verbatim, so list_domains/find_tables/get_context are
      // withheld here to save 1-2 LLM tool round-trips per request.
      tools: toolNames([
        "get_table_schema",
        "list_searchable_columns",
        "list_business_rules",
        "get_allowed_values",
        "build_schema_block",
      ]),
      middleware: [readOnlyFs()],
      responseFormat: PlannerResponse,
    },
    {
      name: "writer",
      description:
        "Write ONE read-only SELECT from the planner context as SQL-only JSON (no AST — code builds it). Call after planner.",
      systemPrompt: loadStagePrompt("writer"),
      // No list_domains: skill selection is automatic via SkillsMiddleware;
      // one get_context call replaces the old tool fan-out.
      tools: toolNames([
        "find_tables",
        "get_table_schema",
        "list_searchable_columns",
        "list_business_rules",
        "get_allowed_values",
        "build_schema_block",
        "get_context",
      ]),
      middleware: [readOnlyFs()],
      responseFormat: WriterResponse,
      skills: ["/skills/"],
    },
  ];
  // Per-stage LLM budgets (override via LLM_CALL_LIMIT_<STAGE>).
  const budgets: Record<string, number> = {
    planner: 10,
    writer: 6,
  };
  return subs.map((s) => ({
    ...s,
    middleware: [
      ...(s.middleware ?? []),
      createLlmCallLimit(s.name, budgets[s.name] ?? DEFAULT_SUBAGENT_LLM_CALL_LIMIT),
    ],
  }));
}
