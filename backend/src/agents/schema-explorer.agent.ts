// Schema explorer subagent.
// Replaces SchemaFinder keyword scoring and ColumnValueMapper regex term
// extraction with tool-supplied facts plus LLM reasoning. Tools provide the
// schema facts; the model decides relevance, search scope, and patterns.
// Unknown tables or non-searchable scope entries are filtered deterministically.
// Prompt text lives in prompts/schema-explorer.prompt.md (see PROMPTMAP.md); this file
// only computes the {{variables}} and renders.

import { chat, resolveLlmModel } from "../orchestration/llm-client";
import type { ConfigSnapshot } from "../config/domain-config";
import {
  createTracker,
  findTables,
  getTableSchema,
  listSearchableColumns,
  type TriggerRecord,
} from "../tools/snapshot-tools";
import { buildSchemaBlock } from "../tools/schema-formatter";
import { renderPrompt } from "../prompting/template-loader";

export interface ExplorerInput {
  canonical_query: string;
  domain: string;
  snapshot: ConfigSnapshot;
}

export interface ExplorerOutput {
  relevantTables: string[];
  searchScope: string[];
  likePattern: string | null;
  operator: "LIKE" | "REGEXP" | "NONE";
  complexity: "simple" | "medium" | "complex";
  reasoning: string;
  triggers: TriggerRecord[];
  model: string;
  live: boolean;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Domain-fixed table scope. Non-default domains with explicit
 * `allowedTables` bypass LLM table reasoning and use the full
 * allow-list directly. Default (empty allow-list) returns null
 * so the caller falls through to LLM reasoning.
 */
export function getDomainFixedTables(snapshot: ConfigSnapshot, domain: string): string[] | null {
  const entry = snapshot.domains.find(
    (d) => d.canonical_name === domain || d.canonical_name.toLowerCase() === domain.toLowerCase()
  );
  if (!entry || entry.allowedTables.length === 0) return null;
  if (entry.canonical_name.toLowerCase() === "default") return null;
  return [...entry.allowedTables];
}

function resolveRelevantTables(
  parsed: Record<string, unknown>,
  inScope: string[],
  fixedTables: string[] | null
): string[] {
  if (fixedTables) return [...fixedTables];
  const known = new Set(inScope);
  if (Array.isArray(parsed.relevantTables)) {
    const filtered = parsed.relevantTables.filter(
      (t: unknown) => typeof t === "string" && known.has(t)
    );
    if (filtered.length > 0) return filtered as string[];
  }
  return [...inScope];
}

export async function exploreSchema(input: ExplorerInput): Promise<ExplorerOutput> {
  const { canonical_query, domain, snapshot } = input;
  const tracker = createTracker();

  const fixedTables = getDomainFixedTables(snapshot, domain);
  const inScope = findTables(snapshot, domain, tracker);
  for (const t of inScope) getTableSchema(snapshot, t, tracker);
  const searchable = listSearchableColumns(snapshot, inScope, tracker);
  if (fixedTables) {
    tracker.record("domainFixedScope", `domain=${domain} tables=${fixedTables.join(",")}`);
  }

  const systemPrompt = renderPrompt("schema-explorer", {
    schema_facts: buildSchemaBlock(snapshot, inScope),
    searchable_columns: searchable.join(", ") || "(none)",
    domain,
  });

  const model = resolveLlmModel("SIMPLE_MODEL", snapshot.llmGuard.fast_model);
  const startTime = Date.now();
  const res = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: canonical_query },
    ],
    { model, temperature: 0.0, spanName: "explore-schema" }
  );

  const parsed = (res.parsed || {}) as {
    relevantTables?: unknown;
    searchScope?: unknown;
    likePattern?: unknown;
    operator?: unknown;
    complexity?: unknown;
    reasoning?: unknown;
  };
  const relevantTables = resolveRelevantTables(
    parsed as Record<string, unknown>,
    inScope,
    fixedTables
  );
  const searchableSet = new Set(searchable);
  const searchScope = Array.isArray(parsed.searchScope)
    ? parsed.searchScope.filter((c: unknown) => typeof c === "string" && searchableSet.has(c))
    : [];
  const likePattern =
    typeof parsed.likePattern === "string" && parsed.likePattern ? parsed.likePattern : null;
  // Pattern-vs-literal discipline: regex char-classes (e.g. [0-9]) or
  // number/digit intent use REGEXP, never LIKE delimiter expansion.
  // MySQL LIKE has no [...] classes, so LIKE '%[0-9]%' would be wrong.
  const REGEX_HINT = /\[.*\]|[\^$*+?()|\\]|contains?\s+(a\s+)?(number|digit)|digits?/i;
  const rawOperator = typeof parsed.operator === "string" ? parsed.operator.toUpperCase() : "";
  const operator: ExplorerOutput["operator"] =
    rawOperator === "REGEXP" || rawOperator === "RLIKE"
      ? "REGEXP"
      : rawOperator === "LIKE"
        ? likePattern && REGEX_HINT.test(`${likePattern} ${canonical_query}`)
          ? "REGEXP"
          : "LIKE"
        : !likePattern
          ? "NONE"
          : REGEX_HINT.test(`${likePattern} ${canonical_query}`)
            ? "REGEXP"
            : "LIKE";
  let complexity: ExplorerOutput["complexity"] =
    parsed.complexity === "medium" || parsed.complexity === "complex" || parsed.complexity === "simple"
      ? parsed.complexity
      : relevantTables.length > 1 || likePattern
        ? "medium"
        : "simple";
  if (fixedTables && relevantTables.length > 1 && complexity === "simple") {
    complexity = "medium";
  }
  const baseReasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  const reasoning = fixedTables
    ? `Domain-fixed scope for "${domain}": using full allow-list [${fixedTables.join(", ")}]. ${baseReasoning}`.trim()
    : baseReasoning;

  tracker.record(
    "explore-schema",
    `relevant=${relevantTables.join(",")} scope=${searchScope.length} latency=${Date.now() - startTime}ms`
  );

  return {
    relevantTables,
    searchScope,
    likePattern,
    operator,
    complexity,
    reasoning,
    triggers: tracker.list(),
    model: res.model,
    live: res.live,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
    tokensIn: res.promptTokens,
    tokensOut: res.completionTokens,
  };
}
