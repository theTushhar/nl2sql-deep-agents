// Independent dual-writer validators (deterministic, fail-closed).
// Each validator returns issue strings; empty = pass. Never silently repairs
// semantics: missing filters, dropped filters, altered projections, or
// ambiguity-to-success conversions are errors, not warnings.

import { QueryAstV2Schema, validateAstCatalog, validateAstLimits, type QueryAstV2 } from "../contracts/query-ast-v2";
import { buildCatalogWhitelist, extractSqlTables, extractAstTables } from "./ast-validator";
import { getDomainDefinition } from "./domains";
import type { ConfigSnapshot } from "./config";

function collectAstFields(pred: unknown, out: Array<{ alias: string; field: string }>): void {
  if (!pred || typeof pred !== "object") return;
  const p = pred as Record<string, unknown>;
  for (const key of ["field", "left", "right", "child", "expression"]) {
    const v = p[key] as Record<string, unknown> | undefined;
    if (v && typeof v === "object" && v.kind === "field") {
      out.push({ alias: String(v.alias), field: String(v.field) });
    }
  }
  if (Array.isArray(p.children)) for (const c of p.children) collectAstFields(c, out);
  if (p.child) collectAstFields(p.child, out);
}

function astHasAggregate(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.kind === "aggregate") return true;
  if (Array.isArray(n.children)) return (n.children as unknown[]).some(astHasAggregate);
  if (n.child) return astHasAggregate(n.child);
  if (n.left) return astHasAggregate(n.left);
  if (n.expression) return astHasAggregate(n.expression);
  return false;
}

/** 1. Strict v2 shape (unknown keys rejected, version 2.0, limit requires orderBy). */
export function validateAstShape(candidate: unknown): { ast: QueryAstV2 | null; issues: string[] } {
  const parsed = QueryAstV2Schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ast: null,
      issues: parsed.error.issues.map((e) => `${Array.isArray(e.path) ? e.path.join(".") : String(e.path)}: ${e.message}`),
    };
  }
  return { ast: parsed.data, issues: [] };
}

/** 2. Catalog check: every alias.field must exist in the snapshot. */
export function validateAstCatalogCheck(ast: QueryAstV2, snapshot: ConfigSnapshot): string[] {
  return validateAstCatalog(ast, buildCatalogWhitelist(snapshot));
}

/** 3. Deployment limits: predicate nodes, boolean depth, joins, group/order caps via schema + extra checks. */
export function validateAstLimitsCheck(ast: QueryAstV2): string[] {
  return validateAstLimits(ast);
}

/** 4. Domain AST: pinned projection enforced in code, never prompt-only. */
export function validateDomainAst(
  ast: QueryAstV2,
  opts: { domain: string; requiredProjection?: { field?: string } }
): string[] {
  const def = getDomainDefinition(opts.domain);
  const requiredField = (opts.requiredProjection?.field || def?.requiredProjection?.field || "").trim();
  if (!requiredField) return [];
  const actual = ast.projection?.field?.field ?? "";
  if (actual.toUpperCase() !== requiredField.toUpperCase()) {
    return [`projection: domain "${def?.name ?? opts.domain}" requires "${requiredField}" but AST projects "${actual}"`];
  }
  if (ast.projection.distinct !== true || ast.projection.output !== "PARENT_UUID") {
    return [`projection: domain "${def?.name ?? opts.domain}" requires distinct:true + output PARENT_UUID`];
  }
  return [];
}

/** 5. Business rules: applied IDs must be known; status predicates require a declared rule. */
export function validateBusinessRules(
  ast: QueryAstV2,
  appliedRuleIds: string[],
  snapshot: ConfigSnapshot
): string[] {
  const issues: string[] = [];
  const known = new Set(snapshot.businessRules.map((r) => r.id));
  for (const id of appliedRuleIds) {
    if (!known.has(id)) issues.push(`Unknown business rule "${id}"`);
  }
  const refs: Array<{ alias: string; field: string }> = [];
  if (ast.where) collectAstFields(ast.where, refs);
  if (ast.having) collectAstFields(ast.having, refs);
  const hasStatus = refs.some((r) => r.field.toUpperCase() === "TEST_CASE_STATUS");
  if (hasStatus && appliedRuleIds.length === 0) {
    issues.push("UNDECLARED_STATUS_FILTER: AST filters TEST_CASE_STATUS with no declared business rule");
  }
  return issues;
}

/** 6. SQL validation is owned by runStaticChecks; this helper checks the domain table contract. */
export function validateSqlDomainContract(sql: string, domain: string, snapshot: ConfigSnapshot): string[] {
  const issues: string[] = [];
  const def = getDomainDefinition(domain);
  const tables = extractSqlTables(sql);
  if (def && def.allowedEntities.length > 0) {
    const allowed = new Set(def.allowedEntities.map((t) => t.toUpperCase()));
    for (const t of tables) {
      if (!allowed.has(t.toUpperCase())) issues.push(`Hallucinated table "${t}" for domain "${def.name}"`);
    }
  }
  if (def?.requiredProjection) {
    const upper = sql.toUpperCase();
    if (!upper.includes("SELECT DISTINCT") || !upper.includes(def.requiredProjection.field.toUpperCase())) {
      issues.push(`projection: domain "${def.name}" requires SELECT DISTINCT ${def.requiredProjection.field}`);
    }
  }
  return issues;
}

/** 7. Semantic reconciliation between independently generated SQL and AST. */
export function compareSqlAndAstSemantics(sql: string, ast: QueryAstV2): string[] {
  const issues: string[] = [];
  const sqlTables = new Set(extractSqlTables(sql).map((t) => t.toUpperCase()));
  const astTables = new Set(extractAstTables(ast).map((t) => t.toUpperCase()));
  for (const t of astTables) if (!sqlTables.has(t)) issues.push(`AST table ${t} missing from SQL`);
  for (const t of sqlTables) if (!astTables.has(t)) issues.push(`SQL table ${t} missing from AST`);

  const fromMatch = sql.match(/\bFROM\s+([A-Z0-9_]+)/i);
  const fromTable = (fromMatch?.[1] || "").toUpperCase();
  if (fromTable && ast.root?.entity && fromTable !== ast.root.entity.toUpperCase()) {
    issues.push(`Root entity mismatch: SQL FROM ${fromTable} vs AST root ${ast.root.entity}`);
  }

  const sqlHasGroupBy = /\bGROUP\s+BY\b/i.test(sql);
  const astHasGroupBy = (ast.groupBy ?? []).length > 0;
  if (sqlHasGroupBy !== astHasGroupBy) issues.push("GROUP BY mismatch between SQL and AST");

  const sqlHasHaving = /\bHAVING\b/i.test(sql);
  const astHasHaving = Boolean(ast.having);
  if (sqlHasHaving !== astHasHaving) issues.push("HAVING mismatch between SQL and AST");

  const sqlHasAgg = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql);
  const astHasAgg =
    astHasAggregate(ast.having) ||
    (ast.orderBy ?? []).some((o) => astHasAggregate(o.expression));
  if (sqlHasAgg && !astHasAgg && !astHasGroupBy) {
    issues.push("Aggregation mismatch: SQL aggregates with no AST aggregation");
  }

  const sqlLimit = sql.match(/\bLIMIT\s+(\d+)/i);
  if (sqlLimit && !ast.limit) issues.push("LIMIT mismatch: SQL has LIMIT with no AST limit");
  if (ast.limit && !(ast.orderBy?.length ?? 0)) issues.push("AST limit requires deterministic orderBy");

  return issues;
}

export const GENERATION_DISAGREEMENT = "GENERATION_DISAGREEMENT";
