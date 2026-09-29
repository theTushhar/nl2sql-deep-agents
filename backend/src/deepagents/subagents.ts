// Deep Agents subagent definitions.
// Each entry is { name, description, systemPrompt, tools, middleware,
// responseFormat, skills }. systemPrompt comes from prompts/*.prompt.md
// (prompt-based, no boilerplate). responseFormat (zod) replaces
// STRICT-JSON-in-prompt + manual extractJson. Tools are minimal per subagent;
// skills isolate per subagent (no inheritance). `model` is deliberately
// OMITTED everywhere: all subagents inherit the single LLM_MODEL.
//
// Filesystem: every subagent gets the same read-only narrowed middleware
// (read_file only — it replaces the default full set by name). Skill L2 reads
// use read_file; nothing else needs file access. Permissions (write-deny,
// secret-deny) are inherited from the main agent.

import type { SubAgent } from "deepagents";
import { createFilesystemMiddleware } from "deepagents";
import { loadStagePrompt } from "./prompts";
import { snapshotTools } from "./tools";
import { createAppBackend } from "./backend";
import { createLlmCallLimit, DEFAULT_SUBAGENT_LLM_CALL_LIMIT } from "./limits";
import {
  GuardrailResponse,
  NormalizerResponse,
  RouterResponse,
  RephraserResponse,
  ExplorerResponse,
  InterpreterResponse,
  WriterResponse,
  CriticResponse,
  AstResponse,
} from "./schemas";

const BASE_SAFETY =
  "\n\nGlobal safety (applies always): formal proper tone. Read-only SELECT only. " +
  "Never invent tables, columns, or joins. Tenant isolation is applied by the consuming " +
  "service — never invent identity predicates or bind variables.";

function toolNames(names: string[]) {
  return snapshotTools.filter((t) => names.includes((t as { name: string }).name));
}

/** Fresh read-only filesystem middleware (read_file only) per subagent. */
function readOnlyFs() {
  return createFilesystemMiddleware({ backend: createAppBackend(), tools: ["read_file"] });
}

export function buildSubagents(): SubAgent[] {
  const subs: SubAgent[] = [
    {
      name: "input-guard",
      description:
        "Classify safety and intent FIRST on every request: query_data vs general_chitchat vs out_of_scope vs malicious. Call it before any other subagent.",
      systemPrompt: `${loadStagePrompt("input-guard")}${BASE_SAFETY}`,
      tools: [],
      middleware: [readOnlyFs()],
      responseFormat: GuardrailResponse,
    },
    {
      name: "query-normalizer",
      description:
        "Normalize the user question into a canonical data question (domain-agnostic), handling greetings, synonyms, and temporal phrases. Call after input-guard allows the request. Never decides the domain.",
      systemPrompt: `${loadStagePrompt("query-normalizer")}${BASE_SAFETY}`,
      tools: [],
      middleware: [readOnlyFs()],
      responseFormat: NormalizerResponse,
    },
    {
      name: "domain-router",
      description:
        "Route the canonical query to one registered domain (all_test_sets for grid/search, default for analytical reporting). Use list_domains tool; never invent domains. Called only when the request domain is default/unpinned; a pinned request domain skips this step.",
      systemPrompt: `${loadStagePrompt("domain-router")}${BASE_SAFETY}`,
      tools: toolNames(["list_domains"]),
      middleware: [readOnlyFs()],
      responseFormat: RouterResponse,
    },
    {
      name: "domain-rephraser",
      description:
        "Rephrase the generic canonical query for the resolved domain and re-review intent/complexity under that domain's projection contract. Call after domain resolution on every allowed request, before schema-explorer and business-rules.",
      systemPrompt: `${loadStagePrompt("domain-rephraser")}${BASE_SAFETY}`,
      tools: toolNames(["list_domains"]),
      middleware: [readOnlyFs()],
      responseFormat: RephraserResponse,
    },
    {
      name: "schema-explorer",
      description:
        "Pick relevant tables, text-search scope (SEARCHABLE columns only), LIKE/REGEXP pattern, and complexity for the domain-canonical query. Use find_tables, get_table_schema, list_searchable_columns tools.",
      systemPrompt: `${loadStagePrompt("schema-explorer")}${BASE_SAFETY}`,
      tools: snapshotTools,
      middleware: [readOnlyFs()],
      responseFormat: ExplorerResponse,
    },
    {
      name: "business-rules",
      description:
        "Select business-rule IDs by meaning for the domain-canonical query using list_business_rules. Return IDs only; SQL clauses are joined deterministically in code.",
      systemPrompt: `${loadStagePrompt("business-rules")}${BASE_SAFETY}`,
      tools: toolNames(["list_business_rules"]),
      middleware: [readOnlyFs()],
      responseFormat: InterpreterResponse,
    },
    {
      name: "sql-writer",
      description:
        "Write ONE single read-only SELECT query from the certified context (schema block, search scope, measures/filters/orderBy, retry critique). Obey LIKE-vs-REGEXP discipline. Use build_schema_block first.",
      systemPrompt: `${loadStagePrompt("sql-writer")}${BASE_SAFETY}`,
      tools: snapshotTools,
      middleware: [readOnlyFs()],
      responseFormat: WriterResponse,
      skills: ["/skills/general/", "/skills/domains/"],
    },
    {
      name: "sql-critic",
      description:
        "Validate a candidate SQL against the whitelist: single SELECT, known tables/columns, declared aliases, SEARCHABLE-only patterns, no binds. Returns valid + fixable critique.",
      systemPrompt: `${loadStagePrompt("sql-critic")}${BASE_SAFETY}`,
      tools: [],
      middleware: [readOnlyFs()],
      responseFormat: CriticResponse,
      skills: ["/skills/critic/"],
    },
    {
      name: "ast-generator",
      description:
        "Translate ALREADY-CERTIFIED SQL into AST v2 JSON (mirror the SQL projection/tables/joins, never re-decide). Call only after sql-critic returns valid=true on success paths. If a SQL construct has no AST equivalent, return unsupported=true.",
      systemPrompt: `${loadStagePrompt("ast-generator")}${BASE_SAFETY}`,
      tools: toolNames(["get_table_schema", "build_schema_block"]),
      middleware: [readOnlyFs()],
      responseFormat: AstResponse,
    },
  ];
  // Per-subagent LLM call budget: at most 3 model calls per task invocation
  // by default (one retry headroom over the 1–2 calls a stage needs), then
  // fail fast instead of looping. Assign per stage via
  // LLM_CALL_LIMIT_<STAGE> (e.g. LLM_CALL_LIMIT_SQL_WRITER=5) or globally
  // via AGENT_LLM_CALL_LIMIT (see limits.ts).
  return subs.map((s) => ({
    ...s,
    middleware: [
      ...(s.middleware ?? []),
      createLlmCallLimit(s.name, DEFAULT_SUBAGENT_LLM_CALL_LIMIT),
    ],
  }));
}
