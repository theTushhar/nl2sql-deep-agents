// Live query evals: runs every case in query-cases.ts through the real
// coordinator (needs LLM key) and checks kind + SQL shape + AST + envelope.
// Usage: npm run eval:queries
// Add new queries to query-cases.ts — no runner changes needed.

import "dotenv/config";
import { answerQuestion } from "../../src/agent/coordinator";
import { validateEnvelope } from "../../src/contracts/envelope-validator";
import { extractSqlTables } from "../../src/domain/ast-validator";
import { QUERY_CASES, type QueryCase } from "./query-cases";

const TIME_CONTEXT = {
  time_zone: "Asia/Calcutta",
  now: "2026-09-25T15:30:00+05:30",
  week_starts_on: "MONDAY",
};

/** Uppercase + single-spaced so fragments match regardless of formatting. */
function normalize(sql: string): string {
  return sql.toUpperCase().replace(/\s+/g, " ").trim();
}

interface CaseResult {
  name: string;
  pass: boolean;
  kind: string;
  latencyMs: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  failures: string[];
  sql: string | null;
}

async function runCase(c: QueryCase, i: number): Promise<CaseResult> {
  const failures: string[] = [];
  const started = Date.now();
  const result = await answerQuestion({
    requestId: `eval-${c.name}`,
    threadId: `eval-thread-${i}`,
    question: c.query,
    dialect: c.dialect ?? "mysql",
    domain: c.domain,
    includeAst: true,
    timeContext: TIME_CONTEXT,
  });
  const latencyMs = Date.now() - started;
  const traces = result.envelope.telemetry?.llmTraces ?? [];
  const tokensIn = traces.reduce((s, t) => s + (t.promptTokens || 0), 0);
  const tokensOut = traces.reduce((s, t) => s + (t.completionTokens || 0), 0);

  const expectKind = c.expectKind ?? "success";
  if (result.kind !== expectKind) {
    failures.push(`kind: expected ${expectKind}, got ${result.kind}`);
  }
  const envIssues = validateEnvelope(result.envelope, result.kind);
  if (envIssues.length > 0) {
    failures.push(
      `envelope: ${envIssues.map((x) => `${x.path}: ${x.message}`).join("; ")}`
    );
  }

  const sql = result.envelope.sql;
  if (c.expectedSql) {
    if (!sql) {
      failures.push("sql: expected SQL, got null");
    } else {
      const norm = normalize(sql);
      for (const frag of c.expectedSql.contains) {
        if (!norm.includes(frag)) failures.push(`sql: missing ${JSON.stringify(frag)}`);
      }
      for (const frag of c.expectedSql.notContains ?? []) {
        if (norm.includes(frag)) failures.push(`sql: forbidden ${JSON.stringify(frag)} present`);
      }
      if (c.expectedSql.tables) {
        const got = [...extractSqlTables(sql)].sort();
        const want = [...c.expectedSql.tables].sort();
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          failures.push(`tables: expected [${want}], got [${got}]`);
        }
      }
    }
  }
  if ((c.expectAst ?? true) && expectKind === "success" && result.envelope.ast == null) {
    failures.push("ast: expected non-null AST v2");
  }

  return {
    name: c.name,
    pass: failures.length === 0,
    kind: result.kind,
    latencyMs,
    llmCalls: traces.length,
    tokensIn,
    tokensOut,
    failures,
    sql,
  };
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];
  for (let i = 0; i < QUERY_CASES.length; i += 1) {
    const c = QUERY_CASES[i] as QueryCase;
    console.log(`[eval] ${i + 1}/${QUERY_CASES.length} ${c.name}: ${JSON.stringify(c.query)}`);
    try {
      results.push(await runCase(c, i));
    } catch (err) {
      results.push({
        name: c.name, pass: false, kind: "threw", latencyMs: 0,
        llmCalls: 0, tokensIn: 0, tokensOut: 0,
        failures: [`threw: ${err instanceof Error ? err.message : String(err)}`], sql: null,
      });
    }
    const r = results[results.length - 1] as CaseResult;
    console.log(
      `[eval] ${r.pass ? "PASS" : "FAIL"} ${r.name} kind=${r.kind} calls=${r.llmCalls} ` +
      `tok=${r.tokensIn}+${r.tokensOut} ${r.latencyMs}ms` +
      (r.pass ? "" : ` :: ${r.failures.join(" | ")}`)
    );
    if (!r.pass && r.sql) console.log(`[eval] sql was: ${r.sql}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const totalTok = results.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
  console.log(
    JSON.stringify({
      eval: passed === results.length ? "PASS" : "FAIL",
      passed, total: results.length,
      totalTokens: totalTok,
      cases: results.map((r) => ({ name: r.name, pass: r.pass, kind: r.kind, failures: r.failures })),
    })
  );
  if (passed !== results.length) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(JSON.stringify({ eval: "FAIL", error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
