// End-to-end validation over the full pipeline.
// Chains the full new path per question — guardrail, debugger, router,
// explorer + interpreter in parallel, certify gate — and asserts the
// certified SQL carries the expected fragments and no forbidden ones.
// Only critic-certified SQL can pass: the gate returns null otherwise.
// Usage: npm run shadow:phase4 (live when OPENAI_API_KEY is set).
// Promotion requires live runs on real queries approved by you.

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { loadSnapshot } from "../src/config/domain-config";
import { analyzeGuardrail } from "../src/agents/input-guard.agent";
import { normalizeQuery } from "../src/agents/query-normalizer.agent";
import { routeDomain } from "../src/agents/domain-router.agent";
import { exploreSchema } from "../src/agents/schema-explorer.agent";
import { interpretRules } from "../src/agents/business-rules.agent";
import { certifySql } from "../src/orchestration/certification-gate";
import { flushTraces } from "../src/orchestration/observability";

interface GoldenE2E {
  id: string;
  question: string;
  mustContain: string[];
  mustNotContain: string[];
}

async function main(): Promise<void> {
  if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith("sk-placeholder")) {
    console.log(`[evals] Running in LIVE mode (model: ${process.env.OPENAI_MODEL || "gpt-4o-mini"}). Langfuse tracing: ${process.env.LANGFUSE_ENABLED === "true" ? "ENABLED (" + (process.env.LANGFUSE_BASE_URL || "https://jp.cloud.langfuse.com") + ")" : "DISABLED"}`);
  } else {
    console.warn("[evals] WARNING: OPENAI_API_KEY not configured or placeholder. Running in local fallback mode.");
  }

  const snapshot = loadSnapshot();
  const dir = path.join(__dirname, "golden");
  const goldens: GoldenE2E[] = JSON.parse(fs.readFileSync(path.join(dir, "endToEnd.json"), "utf8"));

  let liveCalls = 0;
  let totalCost = 0;
  let pass = 0;
  const rows: any[] = [];

  for (const g of goldens) {
    const failures: string[] = [];

    const guard = await analyzeGuardrail({ question: g.question, snapshot });
    if (guard.live) liveCalls++;
    totalCost += guard.costUsd;
    if (guard.verdict !== "allow" || guard.intent_type !== "query_data") {
      failures.push(`guardrail stopped the query: ${guard.verdict}/${guard.intent_type}`);
    }

    const debug = await normalizeQuery({ question: g.question, snapshot });
    if (debug.live) liveCalls++;
    totalCost += debug.costUsd;
    if (debug.isConversational) failures.push("debugger resolved conversational");

    const canonical = debug.canonical_query || g.question;

    const routed = await routeDomain({ canonical_query: canonical, snapshot });
    if (routed.live) liveCalls++;
    totalCost += routed.costUsd;

    const [explored, interpreted] = await Promise.all([
      exploreSchema({ canonical_query: canonical, domain: routed.domain_key, snapshot }),
      interpretRules({ canonical_query: canonical, snapshot }),
    ]);
    if (explored.live) liveCalls++;
    if (interpreted.live) liveCalls++;
    totalCost += explored.costUsd + interpreted.costUsd;

    const certified = await certifySql({
      canonical_query: canonical,
      domain: routed.domain_key,
      dialect: "mysql",
      relevantTables: explored.relevantTables,
      searchScope: explored.searchScope,
      likePattern: explored.likePattern,
      operator: explored.operator,
      measures: interpreted.measures,
      filters: interpreted.filters,
      orderBy: interpreted.orderBy,
      complexity: explored.complexity,
      snapshot,
    });
    totalCost += certified.costUsd;

    if (!certified.certified || !certified.sql) {
      failures.push(`gate refused to certify after ${certified.attempts} attempts: ${certified.errors.join("; ")}`);
    } else {
      const upper = certified.sql.toUpperCase();
      for (const frag of g.mustContain) {
        if (!upper.includes(frag.toUpperCase())) failures.push(`missing fragment: ${frag}`);
      }
      for (const frag of g.mustNotContain) {
        if (upper.includes(frag.toUpperCase())) failures.push(`forbidden fragment present: ${frag}`);
      }
    }

    const ok = failures.length === 0;
    if (ok) pass++;
    rows.push({
      id: g.id,
      question: g.question,
      domain: routed.domain_key,
      tables: explored.relevantTables,
      rules: interpreted.appliedRuleIds,
      attempts: certified.attempts,
      certified: certified.certified,
      sql: certified.sql,
      warnings: certified.warnings,
      failures,
      pass: ok,
      costUsd: Math.round((guard.costUsd + debug.costUsd + routed.costUsd + explored.costUsd + interpreted.costUsd + certified.costUsd) * 1_000_000) / 1_000_000,
    });
  }

  const summary = {
    mode: liveCalls > 0 ? "live" : "local-fallback (promotion requires live runs)",
    endToEnd: `${pass}/${goldens.length}`,
    totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
  };

  console.log(JSON.stringify({ summary, rows }, null, 2));

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "phase4-shadow.json"),
    JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2)
  );

  await flushTraces();

  if (pass !== goldens.length) process.exitCode = 1;
}

void main();
