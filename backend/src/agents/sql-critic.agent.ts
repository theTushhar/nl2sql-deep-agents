// SQL critic subagent.
// Two layers: deterministic static checks run first (exact structural
// properties), then the LLM validation agent for semantic checks (explicit
// projection, hallucinated tables, tenant binds, scope warnings).
// Static failures force valid=false regardless of the LLM verdict.
// Domain-specific projection guidance lives in generation skills, not here.
// Prompt text lives in prompts/sql-critic.prompt.md (see PROMPTMAP.md); this file
// only computes the {{variables}} and renders.

import { chat, resolveLlmModel } from "../orchestration/llm-client";
import type { ConfigSnapshot } from "../config/domain-config";
import { runStaticChecks, hasWildcardProjection, findNonSearchablePredicates } from "./sql-guardrails";
import { renderPrompt } from "../prompting/template-loader";

/**
 * Deterministic veto over LLM error claims.
 * Static facts win: an LLM "wildcard projection" error is dropped when the
 * SQL contains no `*` projection, and an LLM "non-searchable column" error is
 * dropped when every pattern predicate in the SQL targets a SEARCHABLE
 * column. All other LLM errors pass through untouched.
 * Pure function — unit-testable without LLM calls.
 */
export function vetoLlmFalsePositives(
  llmErrors: string[],
  sql: string,
  snapshot: ConfigSnapshot
): { kept: string[]; vetoed: string[] } {
  const kept: string[] = [];
  const vetoed: string[] = [];
  const wildcardClean = !hasWildcardProjection(sql);
  const searchableClean = findNonSearchablePredicates(sql, snapshot).length === 0;
  for (const e of llmErrors) {
    if (wildcardClean && /wildcard/i.test(e)) {
      vetoed.push(e);
      continue;
    }
    if (searchableClean && /non-?searchable/i.test(e)) {
      vetoed.push(e);
      continue;
    }
    kept.push(e);
  }
  return { kept, vetoed };
}

export interface CriticInput {
  sql: string;
  canonical_query: string;
  domain: string;
  dialect: string;
  relevantTables: string[];
  /** Binds already present in interpreter filters (org-controlled, allowed). */
  allowedBinds: string[];
  complexity: "simple" | "medium" | "complex";
  snapshot: ConfigSnapshot;
}

export interface CriticOutput {
  valid: boolean;
  errors: string[];
  warnings: string[];
  critique: string;
  unresolved: string[];
  usedTables: string[];
  model: string;
  live: boolean;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export async function critiqueSql(input: CriticInput): Promise<CriticOutput> {
  const staticRes = runStaticChecks(
    input.sql,
    input.relevantTables,
    input.allowedBinds,
    input.snapshot,
    { dialect: input.dialect, domain: input.domain }
  );

  // Searchable tags are load-bearing: the prompt constrains LIKE/REGEXP to
  // [SEARCHABLE] columns, so omitting the tags makes the LLM hallucinate
  // "non-searchable column" rejections for legal predicates.
  const columnWhitelist = input.snapshot.tables
    .filter((t) => input.relevantTables.includes(t.table_name))
    .map((t) => {
      const colList = t.columns.map((c) => `${c.name}${c.searchable ? " [SEARCHABLE]" : ""}`).join(", ");
      return `- Table ${t.table_name} (alias: ${t.alias}): Valid Columns = [${colList}]`;
    })
    .join("\n");

  const systemPrompt = renderPrompt("sql-critic", {
    dialect: (input.dialect || "mysql").toLowerCase(),
    column_whitelist: columnWhitelist || "(none)",
    relevant_tables: input.relevantTables.join(", "),
    allowed_binds: input.allowedBinds.join(", ") || "(none)",
  });

  const model =
    input.complexity === "simple"
      ? resolveLlmModel("SIMPLE_MODEL", "gpt-4o-mini")
      : resolveLlmModel("COMPLEX_MODEL", "gpt-4.1-mini");

  const res = await chat(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Domain: ${input.domain}\nNatural Language Query: ${input.canonical_query}\nCandidate SQL:\n${input.sql}`,
      },
    ],
    { model, temperature: 0.0, spanName: "validate-sql" }
  );

  const parsed = res.parsed && typeof res.parsed === "object" ? res.parsed : {};
  const llmErrors: string[] = Array.isArray(parsed.errors) ? parsed.errors.filter((e: unknown) => typeof e === "string") : [];
  const warnings: string[] = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w: unknown) => typeof w === "string")
    : [];
  const unresolved: string[] = Array.isArray(parsed.unresolved)
    ? parsed.unresolved.filter((u: unknown) => typeof u === "string")
    : [];
  // Deterministic source of truth: static tables always win over LLM claims.
  const usedTables: string[] = staticRes.usedTables;

  // Merge: static errors always count; LLM errors pass through the
  // deterministic veto first so false-positive claims (wildcard /
  // non-searchable) contradicting static facts never trigger retry loops.
  // Vetoed claims are demoted to warnings for visibility, not silently lost.
  const { kept: vettedLlmErrors, vetoed } = vetoLlmFalsePositives(llmErrors, input.sql, input.snapshot);
  const errors = [...staticRes.errors];
  for (const e of vettedLlmErrors) {
    if (!errors.includes(e)) errors.push(e);
  }
  for (const v of vetoed) {
    const note = `Critic claim vetoed by static check (false positive): ${v}`;
    if (!warnings.includes(note)) warnings.push(note);
  }
  for (const w of staticRes.warnings) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  // Fail-closed default stays: an unexplained LLM valid:false (no error strings
  // to audit) still rejects. But when every LLM error string was vetoed against
  // deterministic facts and static checks are clean, the valid:false verdict
  // itself is a false positive — deterministic facts win.
  const llmVetoedEverything = llmErrors.length > 0 && vettedLlmErrors.length === 0;
  const valid =
    errors.length === 0 &&
    (parsed.valid !== false || (staticRes.errors.length === 0 && llmVetoedEverything));
  if (!valid && errors.length === 0) {
    errors.push("Query validation failed.");
  }

  return {
    valid,
    errors,
    warnings,
    critique:
      errors.length > 0
        ? `Fix validation issues: ${errors.join("; ")}`
        : typeof parsed.critique === "string"
          ? parsed.critique
          : "",
    unresolved,
    usedTables,
    model: res.model,
    live: res.live,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
    tokensIn: res.promptTokens,
    tokensOut: res.completionTokens,
  };
}
