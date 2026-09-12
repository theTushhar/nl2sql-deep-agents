import type { SubAgent } from "deepagents";
import { createFilesystemMiddleware } from "deepagents";
import { loadStagePrompt } from "./prompts";
import { snapshotTools } from "./tools";
import { createAppBackend } from "./backend";
import { createLlmCallLimit, DEFAULT_SUBAGENT_LLM_CALL_LIMIT } from "./limits";
import {
  PlannerResponse,
  SqlWriterResponse,
  AstWriterResponse,
} from "./schemas";

function toolNames(names: string[]) {
  return snapshotTools.filter((t) => names.includes((t as { name: string }).name));
}

function readOnlyFs() {
  return createFilesystemMiddleware({ backend: createAppBackend(), tools: ["read_file"] });
}

export const STAGE_BUDGETS: Record<string, number> = {
  planner: 10,
  "sql-writer": 6,
  "ast-writer": 6,
};

export function buildSubagents(): SubAgent[] {
  const subs: SubAgent[] = [
    {
      name: "planner",
      description:
        "Normalize the user question then plan tables, text-search scope, and business rules. Call first on every request.",
      systemPrompt: loadStagePrompt("planner"),
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
      name: "ast-writer",
      description:
        "Generate a database-neutral Query AI AST v2 independently from the planner contract. Never generate or parse SQL.",
      systemPrompt: loadStagePrompt("ast-writer"),
      tools: toolNames(["get_context", "get_table_schema", "list_business_rules", "build_schema_block"]),
      middleware: [readOnlyFs()],
      responseFormat: AstWriterResponse,
      skills: ["/skills/"],
    },
    {
      name: "sql-writer",
      description:
        "Write ONE read-only SELECT from the planner contract as SQL-only JSON. Never generate or parse AST. Call after planner when include_sql=true.",
      systemPrompt: loadStagePrompt("sql-writer"),
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
      responseFormat: SqlWriterResponse,
      skills: ["/skills/"],
    },
  ];

  const budgets: Record<string, number> = { ...STAGE_BUDGETS };
  return subs.map((s) => ({
    ...s,
    middleware: [
      ...(s.middleware ?? []),
      createLlmCallLimit(s.name, budgets[s.name] ?? DEFAULT_SUBAGENT_LLM_CALL_LIMIT),
    ],
  }));
}
