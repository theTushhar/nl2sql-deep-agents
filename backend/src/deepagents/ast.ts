// Deterministic AST helpers (no LLM, no domain branches).
// Moved from the old ast-generator agent: the ast-generator SUBAGENT now only
// translates SQL→JSON, while all validation/repair below runs in code in
// coordinator-deep.ts (fail-closed: invalid AST → ast:null + marker, never a
// weakened AST).

import type { ConfigSnapshot } from "../config/domain-config";
import {
  QueryAstV2Schema,
  validateAstCatalog,
  validateAstLimits,
  validateAstAggregates,
  type QueryAstV2,
  type CatalogWhitelist,
} from "../contracts/query-ast-v2";

/** Build strict whitelist (entities + alias map) from the snapshot. */
export function buildCatalogWhitelist(snapshot: ConfigSnapshot): CatalogWhitelist {
  const entities = new Map<string, Set<string>>();
  const aliases = new Map<string, string>();
  for (const t of snapshot.tables) {
    entities.set(t.table_name, new Set(t.columns.map((c) => c.name)));
    aliases.set(t.alias, t.table_name);
  }
  return { entities, aliases };
}

/** Render catalog with required-vs-allowed split so the model cannot invent step joins. */
export function buildCatalogText(snapshot: ConfigSnapshot, requiredTables?: string[]): string {
  const required = new Set((requiredTables ?? []).map((t) => t.toUpperCase()));
  return snapshot.tables
    .map((t) => {
      const tag = required.size === 0 || required.has(t.table_name.toUpperCase()) ? "REQUIRED" : "ALLOWED (join only if a predicate needs it)";
      return `- ${t.table_name} (alias ${t.alias}) [${tag}]: [${t.columns.map((c) => c.name).join(", ")}]`;
    })
    .join("\n");
}

/** Tables referenced by a SQL string (FROM + JOIN). Upper-cased names. */
export function extractSqlTables(sql: string): string[] {
  const tables: string[] = [];
  const re = /\b(?:FROM|JOIN)\s+([A-Z0-9_]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = (m[1] || "").toUpperCase();
    if (name && !tables.includes(name)) tables.push(name);
  }
  return tables;
}

/** Tables in an AST (root entity + join entities). Upper-cased names. */
export function extractAstTables(ast: QueryAstV2): string[] {
  const tables: string[] = [];
  if (ast.root?.entity) tables.push(ast.root.entity.toUpperCase());
  for (const j of ast.joins ?? []) {
    const e = (j.entity || "").toUpperCase();
    if (e && !tables.includes(e)) tables.push(e);
  }
  return tables;
}

/** SQL↔AST agreement: same table set, otherwise the representations drifted. */
export function validateSqlAgreement(ast: QueryAstV2, sqlTables: string[]): string[] {
  const astTables = new Set(extractAstTables(ast));
  const sql = new Set(sqlTables.map((t) => t.toUpperCase()));
  const issues: string[] = [];
  for (const t of astTables) {
    if (!sql.has(t)) issues.push(`AST table ${t} is not in the certified SQL (${sqlTables.join(",") || "(none)"})`);
  }
  for (const t of sql) {
    if (!astTables.has(t)) issues.push(`SQL table ${t} is missing from the AST`);
  }
  return issues;
}

function aliasToEntity(snapshot: ConfigSnapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of snapshot.tables) m.set(t.alias, t.table_name);
  return m;
}

function refsOf(pred: unknown, out: string[]): void {
  if (!pred || typeof pred !== "object") return;
  const p = pred as Record<string, unknown>;
  for (const key of ["field", "left", "right", "child", "expression"]) {
    const v = p[key] as Record<string, unknown> | undefined;
    if (v && typeof v === "object" && v.kind === "field") out.push(`${String(v.alias)}.${String(v.field)}`);
  }
  if (Array.isArray(p.children)) for (const c of p.children) refsOf(c, out);
  if (p.child) refsOf(p.child, out);
  if (p.field && typeof p.field === "object") refsOf(p.field, out);
}

/**
 * Deterministic structural repair (no LLM, no domain branches): fix missing
 * join type, object-vs-array on, placeholder entity ("TABLE"), binary
 * discriminator, and prune joins to tables neither required nor referenced.
 */
export function repairAstStructure(
  candidate: Record<string, unknown>,
  requiredTables: string[],
  snapshot: ConfigSnapshot
): { repaired: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const out: Record<string, unknown> = { ...(candidate as object) };
  const aliasEntity = aliasToEntity(snapshot);
  const required = new Set(requiredTables.map((t) => t.toUpperCase()));
  if (Array.isArray(out.joins)) {
    const kept: Record<string, unknown>[] = [];
    for (const j of out.joins as Array<Record<string, unknown>>) {
      const join = { ...(j as object) } as Record<string, unknown>;
      if (join.type === undefined) {
        join.type = "INNER";
        notes.push("join.type defaulted to INNER");
      }
      if (join.on && !Array.isArray(join.on)) {
        join.on = [join.on];
        notes.push("join.on wrapped into array");
      }
      const alias = String(join.alias ?? "");
      const entity = String(join.entity ?? "");
      if (!entity || entity.toUpperCase() === "TABLE") {
        const resolved = aliasEntity.get(alias);
        if (resolved) {
          join.entity = resolved;
          notes.push(`join entity resolved from alias ${alias}`);
        }
      }
      kept.push(join);
    }
    // Prune joins to tables neither required nor referenced by predicates.
    const refs: string[] = [];
    refsOf(out.where, refs);
    refsOf(out.having, refs);
    const refTables = new Set(refs.map((r) => r.split(".")[0]?.toUpperCase()));
    out.joins = kept.filter((j) => {
      const entity = String(j.entity ?? "").toUpperCase();
      const alias = String(j.alias ?? "").toUpperCase();
      if (required.has(entity)) return true;
      if (refTables.has(alias)) return true;
      notes.push(`pruned unneeded join ${entity || alias}`);
      return false;
    });
  }
  if (out.where && typeof out.where === "object") {
    const w = out.where as Record<string, unknown>;
    if (w.kind === "binary") {
      const op = String(w.operator ?? "").toUpperCase();
      if (["CONTAINS", "STARTS_WITH", "ENDS_WITH"].includes(op)) {
        out.where = { kind: "text", field: w.left ?? w.field, operator: op, value: String((w.right as Record<string, unknown> | undefined)?.value ?? w.value ?? "") };
        notes.push("where.binary mapped to text");
      } else {
        out.where = { kind: "comparison", left: w.left, operator: mapOperator(op), right: w.right };
        notes.push("where.binary mapped to comparison");
      }
    }
  }
  return { repaired: out, notes };
}

function mapOperator(op: string): string {
  const map: Record<string, string> = { "=": "EQ", "==": "EQ", "!=": "NE", "<>": "NE", ">": "GT", ">=": "GTE", "<": "LT", "<=": "LTE" };
  return map[op] ?? (["EQ", "NE", "GT", "GTE", "LT", "LTE"].includes(op) ? op : "EQ");
}

export interface AstValidation {
  ast: QueryAstV2 | null;
  errors: string[];
  notes: string[];
}

/**
 * Full deterministic AST validation for coordinator-deep.ts:
 * repair → strict v2 shape → catalog → limits → aggregates → SQL agreement.
 * Any failure → ast:null + error strings (caller adds AST_FAILED_MARKER).
 */
export function validateAst(
  candidate: unknown,
  requiredTables: string[],
  snapshot: ConfigSnapshot,
  sqlTables: string[]
): AstValidation {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ast: null, errors: ["AST tool returned no JSON object."], notes: [] };
  }
  const { repaired, notes } = repairAstStructure(
    candidate as Record<string, unknown>,
    requiredTables,
    snapshot
  );
  const shape = QueryAstV2Schema.safeParse(repaired);
  if (!shape.success) {
    return {
      ast: null,
      errors: shape.error.issues.map(
        (e: { path: unknown; message: string }) =>
          `${Array.isArray(e.path) ? e.path.join(".") : String(e.path)}: ${e.message}`
      ),
      notes,
    };
  }
  const whitelist = buildCatalogWhitelist(snapshot);
  const errors = [
    ...validateAstCatalog(shape.data, whitelist),
    ...validateAstLimits(shape.data),
    ...validateAstAggregates(shape.data),
    ...validateSqlAgreement(shape.data, sqlTables),
  ];
  if (errors.length > 0) return { ast: null, errors, notes };
  return { ast: shape.data, errors: [], notes };
}

/** Trusted time-context text (App Engine supplies; server time fills gaps). */
export function buildTimeContextText(timeContext?: {
  time_zone?: string;
  now?: string;
  week_starts_on?: string;
}): string {
  const zone = timeContext?.time_zone || "Asia/Calcutta";
  const now = timeContext?.now || new Date().toISOString();
  const week = timeContext?.week_starts_on || "MONDAY";
  return `time_zone=${zone}, now=${now}, week_starts_on=${week}. Resolve relative dates once into UTC bounds; never emit DB date functions.`;
}

/** Compact search-decision text for the ast-generator task description. */
export function searchSpecText(searchScope: string[], operator: string, likePattern: string | null): string {
  if (operator === "NONE" || !likePattern) return "(none — no text search in this query)";
  return `scope=[${searchScope.join(", ")}] operator=${operator} pattern=${likePattern}`;
}
