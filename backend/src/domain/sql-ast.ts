// Neutral-SQL helpers (no LLM, no domain branches).
// The writer subagent emits AST v2 JSON directly; the only deterministic SQL
// handling left in code is neutral normalization + dialect rendering, used by
// the coordinator before certification and envelope assembly.

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
