// Deterministic QueryPlan helpers (no LLM).
// Principle: the LLM decides semantic facts (intent, entities, measures);
// code derives structural facts (complexity) and enforces plan<->SQL
// consistency (rule coverage, table agreement).
// Pure functions over snapshot + SQL text so they are unit-testable offline.

import type { ConfigSnapshot } from "./config";

export type Complexity = "simple" | "medium" | "complex";

function hasAggregation(sql: string): boolean {
  return /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql) || /\bGROUP\s+BY\b/i.test(sql) || /\bHAVING\b/i.test(sql);
}

function hasJoin(sql: string): boolean {
  return /\bJOIN\b/i.test(sql);
}

function hasSearch(sql: string): boolean {
  return /\b(LIKE|REGEXP|RLIKE)\b/i.test(sql);
}

/**
 * Deterministic complexity classifier.
 * simple  = single table, no aggregation/search.
 * medium  = join and/or text search, no aggregation over joins.
 * complex = aggregation (COUNT/GROUP BY/HAVING) — regardless of join count.
 * The LLM may propose a value; code is authoritative.
 */
export function calculateComplexity(sql: string, tablesUsed: string[]): Complexity {
  const agg = hasAggregation(sql);
  if (agg) return "complex";
  if (tablesUsed.length > 1 || hasJoin(sql) || hasSearch(sql)) return "medium";
  return "simple";
}

function normalizeFragment(s: string): string {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Rule coverage: every appliedRuleId whose sql_clause is known must appear
 * verbatim (normalized) in the certified SQL. Catches the planner-says-
 * COMMITTED / writer-forgets-filter drift. Returns missing rule ids.
 */
export function findMissingRuleClauses(
  appliedRuleIds: string[],
  sql: string,
  snapshot: ConfigSnapshot
): string[] {
  const hay = normalizeFragment(sql);
  const missing: string[] = [];
  for (const id of appliedRuleIds) {
    const rule = snapshot.businessRules.find((r) => r.id === id);
    if (!rule) {
      missing.push(id);
      continue;
    }
    // Default rules only constrain their own target table: skip when the
    // SQL does not touch that table (e.g. commented-steps rule on a
    // TEST_SET-only query is vacuously satisfied).
    if (rule.is_default && !new RegExp(`\\b${rule.target_table}\\b`, "i").test(sql)) continue;
    const needle = normalizeFragment(rule.sql_clause);
    if (needle && !hay.includes(needle)) missing.push(id);
  }
  return missing;
}

/**
 * Undeclared status filter: SQL contains a COMMITTED/DRAFT status predicate
 * that the plan never declared. Informational (warning, not error) — the
 * writer must not invent filters beyond the plan.
 */
export function hasUndeclaredStatusFilter(appliedRuleIds: string[], sql: string): boolean {
  const hay = normalizeFragment(sql);
  const mentionsStatus =
    hay.includes("TEST_CASE_STATUS") && (hay.includes("COMMITTED") || hay.includes("DRAFT"));
  return mentionsStatus && appliedRuleIds.length === 0;
}

/**
 * Plan<->SQL table agreement: tables declared by the writer must match the
 * tables actually present in FROM/JOIN. Returns drift description or null.
 */
export function findTableDrift(declaredTables: string[], sqlTables: string[]): string | null {
  const declared = new Set(declaredTables.map((t) => t.toUpperCase()));
  const actual = new Set(sqlTables.map((t) => t.toUpperCase()));
  const missing = [...actual].filter((t) => !declared.has(t));
  const extra = [...declared].filter((t) => !actual.has(t));
  if (missing.length === 0 && extra.length === 0) return null;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`SQL uses undeclared tables: ${missing.join(",")}`);
  if (extra.length > 0) parts.push(`declared but unused tables: ${extra.join(",")}`);
  return parts.join("; ");
}
