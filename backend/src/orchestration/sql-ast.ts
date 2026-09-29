// AST builder (v1-clean, ast_version "0.1.0") + dialect renderer.
// Deterministic TOOL: pure function of the certified neutral SQL, never LLM.
// Wire shape (7 keys max, omit-when-empty — never send [] / null noise):
//   { ast_version, select, from, joins?, where?, group_by?, order_by?, limit? }
// Conventions:
// - Column refs are single strings "alias.COLUMN" (e.g. "ts.TEST_SET_UUID").
//   Func-wrapped refs keep the wrapper in the string: "LOWER(ts.NAME)".
// - Literals are native JSON (string | number | boolean | null), no {type,value}.
// - SELECT DISTINCT is recorded as distinct:true on each select item (our
//   certified shapes project one column, so this is exact; multi-col means
//   row-distinct). COUNT(DISTINCT c) uses the same per-item flag.
// - JOIN ON is always the string "a.X=b.Y" in v1 (certified joins are
//   col=col only); anything else falls back to the raw ON text.
// - Unknown predicates/projections fall back to {raw} / {col: raw} / raw ON
//   text — the tool never drops information, never returns empty select.
// - Returns null ONLY when no FROM table is found (truly unparseable).

import type { Tracker } from "../contracts/query-envelope";

export const AST_VERSION = "0.1.0" as const;

export type AstOperator = "=" | "<>" | ">" | "<" | ">=" | "<=" | "LIKE" | "REGEXP";

export type AstSelectItem =
  | { col: string; as?: string; distinct?: boolean }
  | { count: string; as?: string; distinct?: boolean };

export interface AstJoin {
  type: "INNER" | "LEFT" | "RIGHT" | "FULL";
  table: string;
  as: string;
  /** Always "a.X=b.Y" in v1; raw ON text when unparseable. */
  on: string;
}

export type AstCondition =
  | { col: string; op: AstOperator; val: string | number | boolean | null }
  | { and: AstCondition[] }
  | { or: Condition[] }
  | { raw: string };

// Alias kept for readability inside the recursive branch types.
type Condition = AstCondition;

export interface AstV1Clean {
  ast_version: typeof AST_VERSION;
  select: AstSelectItem[];
  from: { table: string; as: string };
  joins?: AstJoin[];
  where?: AstCondition | null;
  group_by?: string[];
  order_by?: Array<{ col: string; dir: "ASC" | "DESC" }>;
  limit?: number;
}

const JOIN_TYPES = new Set(["INNER", "LEFT", "RIGHT", "FULL"]);

/** Split top-level commas (paren-aware; string literals are single-quoted). */
function splitTopLevelCommas(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (const ch of list) {
    if (ch === "'") {
      inStr = !inStr;
      cur += ch;
    } else if (inStr) {
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (ch === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseSelect(sql: string): { distinct: boolean; items: AstSelectItem[] } {
  const m = sql.match(/SELECT\s+(DISTINCT\s+)?([\s\S]+?)\s+FROM\s+/i);
  const distinct = Boolean(m && m[1]);
  const list = (m && m[2] ? m[2].trim() : "").replace(/;\s*$/, "");
  if (!list) return { distinct, items: [] };
  const items: AstSelectItem[] = [];
  for (const p of splitTopLevelCommas(list)) {
    const count = p.match(
      /COUNT\s*\(\s*(DISTINCT\s+)?([A-Za-z][\w]*)\.([A-Za-z0-9_]+)\s*\)(?:\s+AS\s+(\w+))?/i
    );
    if (count) {
      const item: AstSelectItem = {
        count: `${count[2]}.${count[3]}`,
        ...(count[4] ? { as: count[4] } : {}),
        ...(count[1] ? { distinct: true } : {}),
      };
      items.push(item);
      continue;
    }
    const col = p.match(
      /(LOWER\s*\(\s*[A-Za-z][\w]*\.[A-Za-z0-9_]+\s*\)|[A-Za-z][\w]*\.[A-Za-z0-9_]+)(?:\s+AS\s+(\w+))?/i
    );
    if (col) {
      const ref = (col[1] || "").replace(/\s+/g, "");
      items.push({
        col: ref,
        ...(col[2] ? { as: col[2] } : {}),
        ...(distinct ? { distinct: true } : {}),
      });
    } else if (p) {
      // Never drop: keep the raw projection text as the col.
      items.push({ col: p, ...(distinct ? { distinct: true } : {}) });
    }
  }
  return { distinct, items };
}

function parseFrom(sql: string): { table: string; as: string } | null {
  const m = sql.match(/\bFROM\s+([A-Z0-9_]+)(?:\s+(?:AS\s+)?([A-Za-z][\w]*))?/i);
  if (!m || !m[1]) return null;
  return { table: m[1].toUpperCase(), as: m[2] || "" };
}

function parseJoins(sql: string): AstJoin[] {
  const out: AstJoin[] = [];
  const re =
    /\b(LEFT|RIGHT|INNER|FULL)?\s*JOIN\s+([A-Z0-9_]+)(?:\s+(?:AS\s+)?([A-Za-z][\w]*))?\s+ON\s+([\s\S]+?)(?=\b(?:LEFT|RIGHT|INNER|FULL)?\s*JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|;?\s*$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const kind = (m[1] || "INNER").toUpperCase();
    const cond = (m[4] || "").trim();
    const eq = cond.match(
      /([A-Za-z][\w]*\.[A-Za-z0-9_]+)\s*(=|<>|!=|<|>|<=|>=)\s*([A-Za-z][\w]*\.[A-Za-z0-9_]+)/
    );
    out.push({
      type: (JOIN_TYPES.has(kind) ? kind : "INNER") as AstJoin["type"],
      table: (m[2] || "").toUpperCase(),
      as: m[3] || "",
      on: eq ? `${eq[1]}${eq[2] === "!=" ? "<>" : eq[2]}${eq[3]}`.replace(/\s+/g, "") : cond,
    });
  }
  return out;
}

function toVal(raw: string): string | number | boolean | null {
  const t = raw.trim();
  if (/^NULL$/i.test(t)) return null;
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^(TRUE|FALSE)$/i.test(t)) return /^true$/i.test(t);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t.replace(/^'|'$/g, "");
}

function parseLeaf(expr: string): AstCondition {
  const m = expr
    .trim()
    .match(
      /(LOWER\s*\(\s*[A-Za-z][\w]*\.[A-Za-z0-9_]+\s*\)|[A-Za-z][\w]*\.[A-Za-z0-9_]+)\s*(REGEXP|LIKE|<>|!=|<=|>=|=|<|>)\s*('[^']*'|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE)/i
    );
  if (!m) return { raw: expr.trim() };
  const op = (m[2] || "").toUpperCase().replace("!=", "<>") as AstOperator;
  return {
    col: (m[1] || "").replace(/\s+/g, ""),
    op,
    val: toVal(m[3] || ""),
  };
}

function splitKeyword(expr: string, keyword: string): string[] {
  const parts: string[] = [];
  const re = new RegExp(`\\b${keyword}\\b`, "gi");
  let depth = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  let inStr = false;
  while ((m = re.exec(expr)) !== null) {
    const idx = m.index;
    let d = 0;
    let s = false;
    for (const ch of expr.slice(last, idx)) {
      if (ch === "'") s = !s;
      else if (!s && ch === "(") d++;
      else if (!s && ch === ")") d = Math.max(0, d - 1);
    }
    void depth;
    if (!inStr && !s && d === 0) {
      parts.push(expr.slice(last, idx));
      last = idx + m[0].length;
    }
    void inStr;
  }
  parts.push(expr.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseWhere(whereClause: string): AstCondition | null {
  const expr = whereClause.trim().replace(/;\s*$/, "");
  if (!expr) return null;
  const andParts = splitKeyword(expr, "AND");
  if (andParts.length > 1) {
    return {
      and: andParts.map((p) => {
        const orParts = splitKeyword(p.replace(/^\(|\)$/g, ""), "OR");
        if (orParts.length > 1) return { or: orParts.map(parseLeaf) };
        return parseLeaf(p);
      }),
    };
  }
  const orParts = splitKeyword(expr, "OR");
  if (orParts.length > 1) return { or: orParts.map(parseLeaf) };
  return parseLeaf(expr.replace(/^\(([\s\S]*)\)$/, "$1"));
}

function clauseAfter(sql: string, keyword: string): string | null {
  const m = sql.match(
    new RegExp(`\\b${keyword}\\b\\s+([\\s\\S]+?)(?=\\bHAVING\\b|\\bORDER\\s+BY\\b|\\bLIMIT\\b|;?\\s*$)`, "i")
  );
  return m && m[1] ? m[1].trim() : null;
}

function parseGroupBy(sql: string): string[] | undefined {
  const clause = clauseAfter(sql, "GROUP\\s+BY");
  if (!clause) return undefined;
  const cols = splitTopLevelCommas(clause).map((c) => c.replace(/\s+/g, "")).filter(Boolean);
  return cols.length > 0 ? cols : undefined;
}

function parseOrderBy(sql: string): Array<{ col: string; dir: "ASC" | "DESC" }> | undefined {
  const m = sql.match(/\bORDER\s+BY\b\s+([\s\S]+?)(?=\bLIMIT\b|;?\s*$)/i);
  if (!m || !m[1]) return undefined;
  const items = splitTopLevelCommas(m[1].trim())
    .map((p) => {
      const om = p.trim().match(/^([\s\S]+?)\s+(ASC|DESC)\s*$/i);
      if (om) return { col: (om[1] || "").trim().replace(/\s+/g, ""), dir: (om[2] || "ASC").toUpperCase() as "ASC" | "DESC" };
      return { col: p.trim().replace(/\s+/g, ""), dir: "ASC" as const };
    })
    .filter((i) => Boolean(i.col));
  return items.length > 0 ? items : undefined;
}

function parseLimit(sql: string): number | undefined {
  const m = sql.match(/\s+LIMIT\s+(\d+)\s*;?\s*$/i);
  return m && m[1] ? parseInt(m[1], 10) : undefined;
}

/**
 * Build the v1-clean AST from neutral SQL.
 * Returns null ONLY when no FROM table is found.
 */
export function buildAst(sql: string): AstV1Clean | null {
  const clean = (sql || "").trim();
  if (!clean) return null;
  const from = parseFrom(clean);
  if (!from) return null;
  const { items } = parseSelect(clean);
  const joins = parseJoins(clean);
  const whereMatch = clean.match(
    /\bWHERE\s+([\s\S]+?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|;?\s*$)/i
  );
  const where = whereMatch && whereMatch[1] ? parseWhere(whereMatch[1]) : undefined;
  const groupBy = parseGroupBy(clean);
  const orderBy = parseOrderBy(clean);
  const limit = parseLimit(clean);
  const ast: AstV1Clean = {
    ast_version: AST_VERSION,
    select: items.length > 0 ? items : [{ col: clean }],
    from,
  };
  if (joins.length > 0) ast.joins = joins;
  if (where) ast.where = where;
  if (groupBy) ast.group_by = groupBy;
  if (orderBy) ast.order_by = orderBy;
  if (limit !== undefined) ast.limit = limit;
  return ast;
}

/**
 * Tool entry-point: build the AST and record the trigger for telemetry.
 * Skipped entirely by the coordinator when include_ast=false.
 */
export function buildAstTool(sql: string, tracker?: Tracker): AstV1Clean | null {
  const ast = buildAst(sql);
  tracker?.record("buildAst", ast ? `ok tables=${tablesUsedFromAst(ast).join(",")}` : "outcome=null (no FROM)");
  return ast;
}

/** Canonical logical SQL. Current certified shapes are already neutral. */
export function toDbNeutral(sql: string): string {
  return (sql || "").trim().replace(/;\s*$/, "");
}

/** Render neutral SQL into a target dialect (mysql identity, mssql mapped). */
export function renderDialect(neutralSql: string, dialect: string): string {
  const d = (dialect || "mysql").toLowerCase();
  let out = toDbNeutral(neutralSql);
  if (d === "mssql") {
    out = out.replace(/REGEXP\s+'([^']*)'/gi, (_m, pat: string) => {
      const like = pat.startsWith("%") || pat.endsWith("%") ? pat : `%${pat}%`;
      return `LIKE '${like}'`;
    });
    const lim = out.match(/\s+LIMIT\s+(\d+)\s*;?\s*$/i);
    if (lim) {
      out = out.replace(/\s+LIMIT\s+\d+\s*;?\s*$/i, "");
      out = out.replace(/SELECT\s+(DISTINCT\s+)?/i, (_m, dist: string) => `SELECT ${dist || ""}TOP ${lim[1]} `);
    }
  }
  return out;
}

export function tablesUsedFromAst(ast: AstV1Clean): string[] {
  const tables = new Set<string>();
  if (ast.from?.table) tables.add(ast.from.table);
  for (const j of ast.joins || []) if (j.table) tables.add(j.table);
  return [...tables];
}
