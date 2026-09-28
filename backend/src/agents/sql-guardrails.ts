// Deterministic static SQL checks (exact structural checks, not heuristics).
// Ported from the deterministic layer of backend sqlValidatorNode.ts: these
// verify exact properties (statement type, column whitelist, alias
// declaration) rather than guessing intent, so they are safe to keep exact.
// Any failure forces valid=false. Binds present in interpreter filters are
// org-controlled and allowed; writer-invented tenant binds are rejected.

import type { ConfigSnapshot } from "../config/domain-config";

export interface StaticCheckResult {
  errors: string[];
  warnings: string[];
  usedTables: string[];
}

const FORBIDDEN_STATEMENTS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|REPLACE)\b/i;

function extractTables(sql: string): string[] {
  const tables: string[] = [];
  const re = /\b(?:FROM|JOIN)\s+([A-Z0-9_]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const name = (match[1] || "").toUpperCase();
    if (name && !tables.includes(name)) tables.push(name);
  }
  return tables;
}

function extractAliasColumns(sql: string): Array<{ alias: string; column: string }> {
  const out: Array<{ alias: string; column: string }> = [];
  const re = /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    out.push({ alias: (match[1] || "").toUpperCase(), column: (match[2] || "").toUpperCase() });
  }
  return out;
}

export interface StaticCheckOptions {
  /** Rendering dialect (mysql | mssql). Defaults to mysql. */
  dialect?: string;
  /** Resolved domain for projection gating (all_test_sets enforces UUID invariant). */
  domain?: string;
}

/** Deterministic wildcard-projection fact, shared with the critic veto. */
export function hasWildcardProjection(sql: string): boolean {
  return (
    /SELECT\s+DISTINCT\s+\*/i.test(sql) || /SELECT\s+\*/i.test(sql) || /\b[A-Za-z][A-Za-z0-9_]*\.\*/.test(sql)
  );
}

/**
 * Deterministic LIKE/REGEXP-on-searchable fact, shared with the critic veto.
 * Sees through the writer-mandated `LOWER(col) LIKE '...'` case-insensitive
 * form — the optional `)` between column and operator is the LOWER close.
 * Returns violating `TABLE.COLUMN` names (empty = all pattern predicates legal).
 */
export function findNonSearchablePredicates(sql: string, snapshot: ConfigSnapshot): string[] {
  const aliasToTable = new Map<string, (typeof snapshot.tables)[number]>();
  for (const table of snapshot.tables) {
    aliasToTable.set(table.alias.toUpperCase(), table);
  }
  const searchableSet = new Set<string>();
  for (const table of snapshot.tables) {
    for (const col of table.columns) {
      if (col.searchable) searchableSet.add(`${table.table_name}.${col.name.toUpperCase()}`);
    }
  }
  const violations: string[] = [];
  const predRe = /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+)\s*\)?\s*(LIKE|REGEXP|RLIKE)\s*'/gi;
  let predMatch: RegExpExecArray | null;
  while ((predMatch = predRe.exec(sql)) !== null) {
    const alias = (predMatch[1] || "").toUpperCase();
    const column = (predMatch[2] || "").toUpperCase();
    const table = aliasToTable.get(alias);
    if (!table) continue;
    const qualified = `${table.table_name}.${column}`;
    if (!searchableSet.has(qualified) && !violations.includes(qualified)) {
      violations.push(qualified);
    }
  }
  return violations;
}

export function runStaticChecks(
  sql: string,
  allowedTables: string[],
  allowedBinds: string[],
  snapshot: ConfigSnapshot,
  opts: StaticCheckOptions = {}
): StaticCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const upperSql = sql.toUpperCase();
  const dialect = (opts.dialect || "mysql").toLowerCase();
  const domain = (opts.domain || "").toLowerCase();

  // 1. Read-only single statement.
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    errors.push("Only SELECT queries are allowed.");
  }
  if (FORBIDDEN_STATEMENTS.test(sql)) {
    errors.push("Only SELECT queries are allowed.");
  }
  if (trimmed.replace(/;\s*$/, "").includes(";")) {
    errors.push("Only a single statement is allowed.");
  }

  // 2. Known hallucinated column.
  if (upperSql.includes("TEST_SET_DESCRIPTION")) {
    errors.push(
      "Unknown column 'TEST_SET_DESCRIPTION'. Table TEST_SET does not have a description column. Use TEST_SET_NAME instead."
    );
  }

  // 2b. Wildcard projections are never allowed.
  // NOTE: SELECT DISTINCT alias.COLUMN is a valid explicit projection, not a
  // wildcard — hasWildcardProjection only matches literal `*`.
  if (hasWildcardProjection(sql)) {
    errors.push("Wildcard projection (SELECT * or alias.*) is not allowed. Project explicit columns only.");
  }

  // P0-7: close UNION / comment / time-based exfiltration bypasses.
  // Generic messages only (no schema enumeration to the client).
  if (/\bUNION\b\s+(ALL\s+|DISTINCT\s+)?SELECT\b/i.test(sql)) {
    errors.push("UNION queries are not allowed.");
  }
  // Check comments outside string literals so LIKE '%...%' patterns can't
  // false-positive and real `-- text` comments can't hide.
  const unquoted = sql.replace(/'[^']*'/g, "''");
  if(/(--[ \t]|--[ \t]*$|#[ \t]|\/\*[\s\S]*?\*\/)/im.test(unquoted)) {
    errors.push("SQL comments are not allowed.");
  }
  if (/\b(SLEEP|BENCHMARK)\s*\(/i.test(sql)) {
    errors.push("Time-based functions are not allowed.");
  }
  // MSSQL time-based + rowset exfiltration vectors (generic message).
  if (/\bWAITFOR\s+(DELAY|TIME)\b/i.test(sql)) {
    errors.push("Time-based functions are not allowed.");
  }
  if (/\b(LOAD_FILE|INTO\s+(OUTFILE|DUMPFILE))\b/i.test(sql)) {
    errors.push("File operations are not allowed.");
  }
  if (/\b(OPENROWSET|OPENQUERY|BULK\s+INSERT)\b/i.test(sql)) {
    errors.push("File operations are not allowed.");
  }

  // Dialect rendering guards: neutral SQL is rendered per dialect, so the
  // certified shape must not mix dialect constructs.
  if (dialect === "mssql") {
    if (/\bREGEXP\b|\bRLIKE\b/i.test(sql)) {
      errors.push("REGEXP is not supported in mssql. Use LIKE instead.");
    }
    if (/\bLIMIT\s+\d+/i.test(sql)) {
      errors.push("LIMIT is not supported in mssql. Use TOP instead.");
    }
    if (/`/.test(sql)) {
      errors.push("Backtick quoting is not supported in mssql.");
    }
  } else {
    // mysql keeps TOP out of certified shapes (TOP is mssql rendering).
    if (/SELECT\s+TOP\s+\d+/i.test(sql)) {
      errors.push("TOP is not supported in mysql. Use LIMIT instead.");
    }
  }

  const usedTables = extractTables(sql);

  // 3. Allowed tables (DEFECT/PAGE are recognized concepts -> warning only).
  for (const table of usedTables) {
    if (table === "DEFECT" || table === "PAGE") {
      warnings.push(`${table} not in current scope`);
      continue;
    }
    if (!allowedTables.includes(table)) {
      errors.push(`Hallucinated table: ${table}`);
    }
  }

  // 4. Alias.column whitelist + alias declaration.
  const aliasToTable = new Map<string, (typeof snapshot.tables)[number]>();
  for (const table of snapshot.tables) {
    aliasToTable.set(table.alias.toUpperCase(), table);
  }
  const refs = extractAliasColumns(sql);
  const usedAliases = new Set(refs.map((r) => r.alias));
  for (const ref of refs) {
    const table = aliasToTable.get(ref.alias);
    if (!table) continue;
    const validCols = new Set(table.columns.map((c) => c.name.toUpperCase()));
    if (!validCols.has(ref.column)) {
      errors.push(
        `Unknown column '${ref.column}' on table ${table.table_name}. Valid columns are: [${table.columns.map((c) => c.name).join(", ")}].`
      );
    }
  }
  for (const alias of usedAliases) {
    const table = aliasToTable.get(alias);
    if (!table) continue;
    const declared = new RegExp(`\\b${table.table_name}\\s+(?:AS\\s+)?${alias}\\b`, "i").test(sql);
    if (!declared) {
      errors.push(
        `Table alias '${table.alias}' was used for columns but not declared in FROM/JOIN (e.g. 'FROM ${table.table_name} ${table.alias}'). Aliases must be declared in FROM/JOIN.`
      );
    }
  }

  // 4b. LIKE/REGEXP predicates ONLY on SEARCHABLE columns (deterministic).
  // MySQL LIKE has no [...] classes — that case must be REGEXP, enforced upstream.
  // Operator is recovered from the SQL at the violation site for the message.
  for (const qualified of findNonSearchablePredicates(sql, snapshot)) {
    const opHit = sql.match(new RegExp(`${qualified.split(".")[1]}\\s*\\)?\\s*(LIKE|REGEXP|RLIKE)`, "i"));
    const op = (opHit && opHit[1] ? opHit[1] : "LIKE").toUpperCase();
    errors.push(`${op} predicate on non-searchable column '${qualified}'. Use a SEARCHABLE column.`);
  }

  // 4c. Domain projection gate: all_test_sets is a UUID grid filter.
  if (domain === "all_test_sets") {
    if (!/^SELECT\s+DISTINCT\s+[A-Za-z][\w]*\.TEST_SET_UUID\s+FROM\b/i.test(trimmed)) {
      errors.push("all_test_sets must project exactly SELECT DISTINCT ts.TEST_SET_UUID.");
    }
  }

  // 5. LIKE with bare quoted literal (no % wildcards) on any column.
  const bareLike = /LIKE\s+'[^'%]*'/i.test(sql);
  if (bareLike) {
    errors.push("LIKE predicate without % wildcards. Use an equality predicate or a %term% pattern on a SEARCHABLE column.");
  }

  // 7. Tenant binds: forbidden; tenant isolation and user filtering are caller-applied.
  const bindRe = /:(APP_LOGGED_IN_[A-Z0-9_]+)/gi;
  let bindMatch: RegExpExecArray | null;
  while ((bindMatch = bindRe.exec(sql)) !== null) {
    const bind = `:${(bindMatch[1] || "").toUpperCase()}`;
    errors.push(`Bind variable ${bind} is not supported. Tenant isolation and user filtering are applied by the consuming service.`);
  }

  return { errors, warnings, usedTables };
}
