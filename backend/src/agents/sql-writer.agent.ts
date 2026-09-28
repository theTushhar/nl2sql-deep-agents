// SQL writer subagent.
// Generates the candidate SQL from the full upstream context: canonical
// query, domain, tables, search scope/pattern, interpreter filters, and
// retry critique. Skill layering: query-writing always, domain pack by
// resolved domain, query-critic from the first retry onward. Cheap-tier
// model by complexity (simple -> gpt-4o-mini, medium/complex -> gpt-4.1-mini).
// Search-pattern discipline (Phase 3 finding): LIKE patterns are %term%
// wildcards on SEARCHABLE text columns; equality predicates come from
// interpreter filters, never from the search scope.
// Prompt text lives in prompts/sql-writer.prompt.md (see PROMPTMAP.md); this file
// only computes the {{variables}} and renders.

import { chat, extractJson, resolveLlmModel } from "../orchestration/llm-client";
import type { ConfigSnapshot } from "../config/domain-config";
import { buildSchemaBlock } from "../tools/schema-formatter";
import { createTracker, type TriggerRecord } from "../tools/snapshot-tools";
import { buildSkillBlock, resolveSkillsForContext } from "../skills/skill-loader";
import { renderPrompt } from "../prompting/template-loader";

export interface WriterInput {
  canonical_query: string;
  domain: string;
  dialect: string;
  relevantTables: string[];
  searchScope: string[];
  likePattern: string | null;
  operator: "LIKE" | "REGEXP" | "NONE";
  measures: string[];
  filters: string[];
  orderBy: string[];
  critique: string;
  attempt: number;
  complexity: "simple" | "medium" | "complex";
  snapshot: ConfigSnapshot;
}

export interface WriterOutput {
  sql: string;
  skills: string[];
  triggers: TriggerRecord[];
  model: string;
  live: boolean;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export async function writeSql(input: WriterInput): Promise<WriterOutput> {
  const tracker = createTracker();
  const isRetry = input.attempt > 1;
  const skills = resolveSkillsForContext(input.domain, isRetry);
  const skillBlock = buildSkillBlock(skills);
  tracker.record("write-sql", `attempt=${input.attempt} skills=${skills.join("+")}`);

  const feedbackSection = input.critique
    ? `\n\nPREVIOUS ATTEMPT FAILED CERTIFICATION (attempt ${input.attempt}):\n${input.critique}\nFix these issues directly in your new query.`
    : "";

  const rawTerm = input.likePattern ? input.likePattern.replace(/%/g, "").trim() : "";
  const hasRegexChars = /\[.*\]|[\^$*+?()|\\]/.test(rawTerm);
  const wantsRegexp =
    input.operator === "REGEXP" || hasRegexChars || /contains?\s+(a\s+)?(number|digit)/i.test(input.canonical_query);
  const isPrefix =
    Boolean(input.likePattern && input.likePattern.endsWith("%") && !input.likePattern.startsWith("%")) ||
    /\b(starts with|starts from|starting with|starting from)\b/i.test(input.canonical_query);
  const isMultiWord =
    !hasRegexChars && (rawTerm.includes(" ") || rawTerm.includes("_") || rawTerm.includes("-"));

  let searchGuidance: string;
  if (wantsRegexp && rawTerm) {
    // Pattern match: use REGEXP directly, never LIKE delimiter expansion.
    // MySQL LIKE has no [...] classes; LOWER() is redundant for digit patterns.
    const pattern = rawTerm;
    const useLower = /[a-z]/i.test(pattern.replace(/[0-9\[\]\-\^$*+?()|\\]/g, "")) ? "LOWER(col) " : "";
    searchGuidance =
      `Pattern search "${rawTerm}" detected across scope [${input.searchScope.join(", ")}]. ` +
      `Use ${useLower}REGEXP '${pattern}' with OR across search scope columns (e.g. ts.TEST_SET_NAME REGEXP '[0-9]'). ` +
      `Do NOT use LIKE delimiter variants for regex patterns.`;
  } else if (rawTerm) {
    // Literal keyword search: compare LOWER(col) against lowercase term.
    const lowerTerm = rawTerm.toLowerCase();
    if (isMultiWord) {
      const spaced = lowerTerm.replace(/[_\-]/g, " ");
      const underscored = lowerTerm.replace(/[\s\-]/g, "_");
      const collapsed = lowerTerm.replace(/[\s_\-]/g, "");
      const hyphenated = lowerTerm.replace(/[\s_]/g, "-");
      const variants = Array.from(new Set([spaced, underscored, collapsed, hyphenated]));
      const formattedVariants = variants
        .map((v) => (isPrefix ? `LOWER(col) LIKE '${v}%'` : `LOWER(col) LIKE '%${v}%'`))
        .join(" OR ");
      searchGuidance =
        `Text search term "${lowerTerm}" detected across scope [${input.searchScope.join(", ")}]. ` +
        `Always use case-insensitive LOWER(col) and expand into delimiter variations using OR: (${formattedVariants}).`;
    } else {
      const pattern = isPrefix ? `${lowerTerm}%` : `%${lowerTerm}%`;
      searchGuidance =
        `Text search term "${lowerTerm}" detected across scope [${input.searchScope.join(", ")}]. ` +
        `Apply case-insensitive LIKE using LOWER(column) LIKE '${pattern}' with OR across search scope columns.`;
    }
  } else {
    searchGuidance = `No text search term for this query. Do not add LIKE predicates.`;
  }

  const dialect = (input.dialect || "mysql").toLowerCase();
  const systemPrompt = renderPrompt("sql-writer", {
    domain: input.domain,
    dialect,
    schema_block: buildSchemaBlock(input.snapshot, input.relevantTables),
    search_scope: input.searchScope.join(", ") || "(none)",
    search_guidance: searchGuidance,
    measures: input.measures.join(", ") || "(none)",
    filters: input.filters.join(" AND ") || "(none)",
    order_by: input.orderBy.join(", ") || "(none)",
    feedback_section: feedbackSection,
    skill_block: skillBlock,
  });

  const model =
    input.complexity === "simple"
      ? resolveLlmModel("SIMPLE_MODEL", "gpt-4o-mini")
      : resolveLlmModel("COMPLEX_MODEL", "gpt-4.1-mini");

  const res = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: input.canonical_query },
    ],
    { model, temperature: 0.0, spanName: "generate-sql" }
  );

  const raw = (res.content || "")
    .replace(/```sql/gi, "")
    .replace(/```/g, "")
    .trim();

  // Robust extraction: some models wrap the query in JSON despite the raw-text
  // instruction. Accept {"sql"|"query": "..."} and fall back to raw text.
  let sql = raw;
  if (raw.startsWith("{")) {
    const parsed = extractJson(raw);
    if (parsed && typeof parsed === "object") {
      const candidate = (parsed as Record<string, unknown>).sql ?? (parsed as Record<string, unknown>).query;
      if (typeof candidate === "string" && candidate.trim() !== "") {
        sql = candidate.trim();
      }
    }
  }

  return {
    sql: sql || "SELECT 1",
    skills,
    triggers: tracker.list(),
    model: res.model,
    live: res.live,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
    tokensIn: res.promptTokens,
    tokensOut: res.completionTokens,
  };
}
