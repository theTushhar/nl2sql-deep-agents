// Neutral-SQL helpers (no LLM, no domain branches).
// Deterministic SQL -> AST v2 builder lives here so the writer subagent can
// stay SQL-only: the coordinator builds + validates the AST in code instead
// of paying the LLM ~467 output tokens to hand-compile its own SQL.

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

type FieldRef = { kind: "field"; alias: string; field: string };

function field(alias: string, name: string): FieldRef {
  return { kind: "field", alias, field: name.toUpperCase() };
}

function typedValue(raw: string): { type: string; value: unknown } | null {
  const t = raw.trim();
  const q = t.match(/^'(.*)'$/s);
  if (q) {
    const v = q[1] ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { type: "date", value: v };
    return { type: "string", value: v };
  }
  if (/^(TRUE|FALSE)$/i.test(t)) return { type: "boolean", value: /^TRUE$/i.test(t) };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { type: "number", value: Number(t) };
  return null;
}

function splitTop(sql: string, keyword: string): [string, string] | null {
  const re = new RegExp(`\\b${keyword}\\b`, "i");
  const m = re.exec(sql);
  if (!m || m.index === undefined) return null;
  return [sql.slice(0, m.index), sql.slice(m.index + m[0].length)];
}

function splitAnds(s: string): string[] {
  return s.split(/\bAND\b/i).map((x) => x.trim()).filter(Boolean);
}

function parseComparisonExpr(expr: string): Record<string, unknown> | null {
  const t = expr.trim();
  // LOWER(alias.col) LIKE 'pattern' -> text predicate
  let m = t.match(/^LOWER\(\s*([A-Za-z][\w]*)\.([A-Za-z0-9_]+)\s*\)\s*(LIKE)\s*'(.*)'$/is);
  if (m) return textPred(m[1]!, m[2]!, m[4] ?? "");
  // alias.col LIKE 'pattern' -> text predicate
  m = t.match(/^([A-Za-z][\w]*)\.([A-Za-z0-9_]+)\s*(LIKE)\s*'(.*)'$/is);
  if (m) return textPred(m[1]!, m[2]!, m[4] ?? "");
  // COUNT(alias.col) OP value -> having aggregate comparison
  m = t.match(/^COUNT\s*\(\s*(?:([A-Za-z][\w]*)\.([A-Za-z0-9_]+)|\*)\s*\)\s*(=|==|!=|<>|>=?|<=?)\s*(.+)$/is);
  if (m) {
    const op = mapCmpOp(m[3]!);
    const right = typedValue(m[4]!);
    if (!op || !right) return null;
    const agg: Record<string, unknown> = { kind: "aggregate", function: "COUNT" };
    if (m[1] && m[2]) agg.field = field(m[1], m[2]);
    return { kind: "comparison", left: agg, operator: op, right };
  }
  // alias.col OP value -> comparison
  m = t.match(/^([A-Za-z][\w]*)\.([A-Za-z0-9_]+)\s*(=|==|!=|<>|>=?|<=?)\s*(.+)$/s);
  if (m) {
    const op = mapCmpOp(m[3]!);
    const right = typedValue(m[4]!);
    if (!op || !right) return null;
    return { kind: "comparison", left: field(m[1]!, m[2]!), operator: op, right };
  }
  // IS NULL / IS NOT NULL
  m = t.match(/^([A-Za-z][\w]*)\.([A-Za-z0-9_]+)\s+IS\s+(NOT\s+)?NULL$/i);
  if (m) return { kind: "null", field: field(m[1]!, m[2]!), operator: m[3] ? "IS_NOT_NULL" : "IS_NULL" };
  return null;
}

function textPred(alias: string, col: string, pattern: string): Record<string, unknown> {
  const starts = pattern.startsWith("%");
  const ends = pattern.endsWith("%");
  const value = pattern.replace(/^%+|%+$/g, "");
  const operator = starts && ends ? "CONTAINS" : !starts && ends ? "STARTS_WITH" : starts && !ends ? "ENDS_WITH" : "CONTAINS";
  return { kind: "text", field: field(alias, col), operator, value };
}

function mapCmpOp(op: string): string | null {
  const map: Record<string, string> = { "=": "EQ", "==": "EQ", "!=": "NE", "<>": "NE", ">": "GT", ">=": "GTE", "<": "LT", "<=": "LTE" };
  return map[op] ?? null;
}

function parseWhere(s: string): Record<string, unknown> | null {
  const parts = splitAnds(s);
  if (parts.length === 0) return null;
  const preds: Record<string, unknown>[] = [];
  for (const p of parts) {
    // Reject OR/NOT/BETWEEN/REGEXP/subqueries — caller marks unsupported.
    if (/\b(OR|NOT|BETWEEN|REGEXP|RLIKE|SELECT|EXISTS|IN\s*\()/i.test(p)) {
      // Allow simple IN (a.b IN ('x','y',1)) as set predicate.
      const mi = p.match(/^([A-Za-z][\w]*)\.([A-Za-z0-9_]+)\s+(NOT\s+)?IN\s*\((.+)\)$/is);
      if (!mi) return null;
      const vals = (mi[4] ?? "").split(",").map((v) => typedValue(v.trim())).filter(Boolean) as Array<{ type: string; value: unknown }>;
      if (vals.length === 0) return null;
      preds.push({ kind: "set", field: field(mi[1]!, mi[2]!), operator: mi[3] ? "NOT_IN" : "IN", values: vals });
      continue;
    }
    const c = parseComparisonExpr(p);
    if (!c) return null;
    preds.push(c);
  }
  if (preds.length === 1) return preds[0]!;
  return { kind: "boolean", operator: "AND", children: preds };
}

/**
 * Deterministic SQL -> AST v2 builder for certified shapes.
 * Supports: SELECT [DISTINCT] a.COL FROM T a [JOIN T2 b ON a.c=b.c [AND ...]]
 * [WHERE and-chain] [GROUP BY ...] [HAVING single/AND-chain] [ORDER BY ...]
 * [LIMIT n]. Anything else (OR, NOT, BETWEEN, REGEXP, subqueries, UNION,
 * functions beyond COUNT) returns { ast: null, unsupported: code } so the
 * caller can fall back to the LLM AST or mark AST_FAILED.
 */
export function sqlToAstV2(sql: string): { ast: Record<string, unknown> | null; unsupported?: string } {
  const q = toDbNeutral(sql).replace(/\s+/g, " ").trim();
  if (!/^(SELECT|WITH)\b/i.test(q)) return { ast: null, unsupported: "NOT_SELECT" };
  if (/\b(UNION|INTERSECT|EXCEPT)\b/i.test(q)) return { ast: null, unsupported: "SET_OPERATION" };
  if (/\(\s*SELECT\b/i.test(q)) return { ast: null, unsupported: "SUBQUERY" };
  if (/\bREGEXP\b|\bRLIKE\b/i.test(q)) return { ast: null, unsupported: "REGEXP" };

  const mSel = q.match(/^SELECT\s+(DISTINCT\s+)?([A-Za-z][\w]*)\.([A-Za-z0-9_]+)\s+FROM\s+(.*)$/is);
  if (!mSel) return { ast: null, unsupported: "PROJECTION" };
  const projAlias = mSel[2]!;
  const projField = mSel[3]!.toUpperCase();
  let rest = mSel[4]!;

  // ORDER BY / LIMIT tail (LIMIT requires ORDER BY per contract — enforced by schema).
  let orderBy: Array<Record<string, unknown>> | undefined;
  let limit: number | undefined;
  const mLim = rest.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (mLim) {
    limit = Number(mLim[1]);
    rest = rest.slice(0, mLim.index).trim();
  }
  const mOrd = splitTop(rest, "ORDER\\s+BY");
  if (mOrd) {
    rest = mOrd[0].trim();
    const items = mOrd[1].split(",").map((x) => x.trim()).filter(Boolean);
    orderBy = [];
    for (const it of items) {
      const mo = it.match(/^(?:([A-Za-z][\w]*)\.([A-Za-z0-9_]+)|COUNT\s*\(\s*(?:([A-Za-z][\w]*)\.([A-Za-z0-9_]+)|\*)\s*\))\s*(ASC|DESC)?$/i);
      if (!mo) return { ast: null, unsupported: "ORDER_BY" };
      const dir = (mo[5] || "ASC").toUpperCase();
      if (mo[1] && mo[2]) orderBy.push({ expression: field(mo[1], mo[2]), direction: dir });
      else {
        const agg: Record<string, unknown> = { kind: "aggregate", function: "COUNT" };
        if (mo[3] && mo[4]) agg.field = field(mo[3], mo[4]);
        orderBy.push({ expression: agg, direction: dir });
      }
    }
  }

  // HAVING (must come before GROUP BY split confusion — split HAVING first).
  let having: Record<string, unknown> | undefined;
  const mHav = splitTop(rest, "HAVING");
  if (mHav) {
    rest = mHav[0].trim();
    const h = parseWhere(mHav[1].trim());
    if (!h) return { ast: null, unsupported: "HAVING" };
    having = h;
  }

  // GROUP BY
  let groupBy: Array<FieldRef> | undefined;
  const mGrp = splitTop(rest, "GROUP\\s+BY");
  if (mGrp) {
    rest = mGrp[0].trim();
    groupBy = [];
    for (const g of mGrp[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      const mg = g.match(/^([A-Za-z][\w]*)\.([A-Za-z0-9_]+)$/);
      if (!mg) return { ast: null, unsupported: "GROUP_BY" };
      groupBy.push(field(mg[1]!, mg[2]!));
    }
  }

  // WHERE
  let where: Record<string, unknown> | undefined;
  const mWh = splitTop(rest, "WHERE");
  if (mWh) {
    rest = mWh[0].trim();
    const w = parseWhere(mWh[1].trim());
    if (!w) return { ast: null, unsupported: "WHERE" };
    where = w;
  }

  // FROM + JOINs
  const joinParts = rest.split(/\bJOIN\b/i).map((x) => x.trim()).filter(Boolean);
  const mFrom = joinParts[0]!.match(/^([A-Z0-9_]+)\s+(?:AS\s+)?([A-Za-z][\w]*)$/i);
  if (!mFrom) return { ast: null, unsupported: "FROM" };
  const root = { entity: mFrom[1]!.toUpperCase(), alias: mFrom[2]! };
  const joins: Array<Record<string, unknown>> = [];
  for (const jp of joinParts.slice(1)) {
    const mj = jp.match(/^([A-Z0-9_]+)\s+(?:AS\s+)?([A-Za-z][\w]*)\s+ON\s+(.+)$/is);
    if (!mj) return { ast: null, unsupported: "JOIN" };
    const onRaw = mj[3]!;
    const eqs = splitAnds(onRaw);
    const on: Array<Record<string, unknown>> = [];
    for (const e of eqs) {
      const me = e.match(/^([A-Za-z][\w]*)\.([A-Za-z0-9_]+)\s*=\s*([A-Za-z][\w]*)\.([A-Za-z0-9_]+)$/);
      if (!me) return { ast: null, unsupported: "JOIN_ON" };
      on.push({ left: field(me[1]!, me[2]!), right: field(me[3]!, me[4]!) });
    }
    // JOIN type: certified shapes use INNER; LEFT only when explicitly written.
    const type = /^\s*LEFT\b/i.test(jp) ? "LEFT" : "INNER";
    joins.push({ type, entity: mj[1]!.toUpperCase(), alias: mj[2]!, on });
  }

  const ast: Record<string, unknown> = {
    version: "2.0",
    root,
    projection: { field: field(projAlias, projField), distinct: true, output: "PARENT_UUID" },
  };
  if (joins.length > 0) ast.joins = joins;
  if (where) ast.where = where;
  if (groupBy) ast.groupBy = groupBy;
  if (having) ast.having = having;
  if (orderBy) ast.orderBy = orderBy;
  if (limit !== undefined) ast.limit = limit;
  return { ast };
}
