// Shadow comparison for router + explorer + interpreter.
// Runs router + explorer + interpreter over golden sets and diffs against
// LEGACY COPIES of the backend mechanisms (comparison only — never ship):
// keyword domain guessing (backend mock), SchemaFinder keyword scoring, and
// trigger-term substring rule matching.
// Usage: npm run shadow:phase3 (live when OPENAI_API_KEY is set).
// Promotion requires live runs on real queries approved by you.

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { loadSnapshot } from "../src/config/domain-config";
import { routeDomain } from "../src/agents/domain-router.agent";
import { exploreSchema } from "../src/agents/schema-explorer.agent";
import { interpretRules } from "../src/agents/business-rules.agent";
import { flushTraces } from "../src/orchestration/observability";

interface GoldenRouter { id: string; question: string; expectedDomain: string; expectedSub: string | null }
interface GoldenExplorer {
  id: string;
  question: string;
  domain: string;
  expectedTables: string[];
  expectedScopeNonEmpty?: boolean;
}
interface GoldenInterpreter { id: string; question: string; expectedRules: string[] }

// --- LEGACY COPY (backend LLMClient mock domain routing, comparison only) ---
function legacyRouter(q: string): string {
  const lower = q.toLowerCase();
  return lower.includes("grid") || lower.includes("personal") || lower.includes("test set")
    ? "all_test_sets"
    : "default";
}

// --- LEGACY COPY (backend SchemaFinder.ts scoring, comparison only) ---
function legacySchema(q: string, allTables: string[]): string[] {
  const query = q.toLowerCase();
  const scores: Record<string, number> = {};
  allTables.forEach((t) => (scores[t] = 0));
  if (query.includes("test set") || query.includes("test_set")) scores["TEST_SET"] = (scores["TEST_SET"] || 0) + 10;
  if (query.includes("test case") || query.includes("test_case")) scores["TEST_CASE"] = (scores["TEST_CASE"] || 0) + 10;
  if (query.includes("step") || query.includes("bdd")) scores["TEST_CASE_STEP"] = (scores["TEST_CASE_STEP"] || 0) + 10;
  if (query.includes("id") || query.includes("uuid")) {
    for (const k of Object.keys(scores)) if ((scores[k] || 0) > 0) scores[k] = (scores[k] || 0) + 5;
  }
  if (Math.max(...Object.values(scores)) === 0) {
    if (query.includes("test") || query.includes("tushar") || query.includes("globalsqa")) {
      for (const k of Object.keys(scores)) scores[k] = 1;
    }
  }
  let relevant = Object.keys(scores)
    .filter((k) => (scores[k] || 0) > 0)
    .sort((a, b) => (scores[b] || 0) - (scores[a] || 0));
  if (relevant.length === 0) relevant = [...allTables];
  return relevant;
}

// --- LEGACY COPY (backend parallelNode.ts trigger-term matching, comparison only) ---
const LEGACY_TRIGGERS: Array<{ id: string; terms: string[]; isDefault: boolean }> = [
  { id: "RULE_ACTIVE_TEST_CASES", terms: ["active", "committed", "published"], isDefault: false },
  { id: "RULE_DRAFT_TEST_CASES", terms: ["draft", "uncommitted", "wip"], isDefault: false },
  { id: "RULE_EXCLUDE_COMMENTED_STEPS", terms: ["*"], isDefault: true },
  { id: "RULE_ORPHAN_TEST_SETS", terms: ["orphan", "unlinked", "standalone"], isDefault: false },
  { id: "RULE_PERSONAL_TEST_SETS", terms: ["personal", "my test sets", "my tests"], isDefault: false },
];

function legacyRules(q: string): string[] {
  const query = q.toLowerCase();
  const ids: string[] = [];
  for (const rule of LEGACY_TRIGGERS) {
    const hit = rule.terms.some((term) => {
      if (term === "*") return rule.isDefault;
      return query.includes(term.toLowerCase());
    });
    if (hit) ids.push(rule.id);
  }
  return ids;
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = [...a].sort().join(",");
  const sb = [...b].sort().join(",");
  return sa === sb;
}

async function main(): Promise<void> {
  if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith("sk-placeholder")) {
    console.log(`[evals] Running in LIVE mode (model: ${process.env.OPENAI_MODEL || "gpt-4o-mini"}). Langfuse tracing: ${process.env.LANGFUSE_ENABLED === "true" ? "ENABLED (" + (process.env.LANGFUSE_BASE_URL || "https://jp.cloud.langfuse.com") + ")" : "DISABLED"}`);
  } else {
    console.warn("[evals] WARNING: OPENAI_API_KEY not configured or placeholder. Running in local fallback mode.");
  }

  const snapshot = loadSnapshot();
  const dir = path.join(__dirname, "golden");
  const routerGoldens: GoldenRouter[] = JSON.parse(fs.readFileSync(path.join(dir, "router.json"), "utf8"));
  const explorerGoldens: GoldenExplorer[] = JSON.parse(fs.readFileSync(path.join(dir, "explorer.json"), "utf8"));
  const interpreterGoldens: GoldenInterpreter[] = JSON.parse(
    fs.readFileSync(path.join(dir, "interpreter.json"), "utf8")
  );
  const allTables = snapshot.tables.map((t) => t.table_name);

  let liveCalls = 0;
  let totalCost = 0;

  let routerPass = 0;
  const routerRows: any[] = [];
  for (const g of routerGoldens) {
    const fresh = await routeDomain({ canonical_query: g.question, snapshot });
    if (fresh.live) liveCalls++;
    totalCost += fresh.costUsd;
    const legacy = legacyRouter(g.question);
    const pass = fresh.domain_key === g.expectedDomain && fresh.sub_domain_key === g.expectedSub;
    if (pass) routerPass++;
    routerRows.push({ id: g.id, question: g.question, expected: `${g.expectedDomain}/${g.expectedSub}`, fresh: `${fresh.domain_key}/${fresh.sub_domain_key}`, legacy, pass, live: fresh.live, costUsd: fresh.costUsd });
  }

  let explorerPass = 0;
  const explorerRows: any[] = [];
  for (const g of explorerGoldens) {
    const fresh = await exploreSchema({ canonical_query: g.question, domain: g.domain, snapshot });
    if (fresh.live) liveCalls++;
    totalCost += fresh.costUsd;
    const legacy = legacySchema(g.question, allTables);
    const tablesOk = g.expectedTables.every((t) => fresh.relevantTables.includes(t));
    const scopeOk = g.expectedScopeNonEmpty === true ? fresh.searchScope.length > 0 && fresh.likePattern !== null : true;
    const pass = tablesOk && scopeOk;
    if (pass) explorerPass++;
    explorerRows.push({
      id: g.id, question: g.question, expectedTables: g.expectedTables,
      freshTables: fresh.relevantTables, freshScope: fresh.searchScope, freshPattern: fresh.likePattern,
      legacyTables: legacy, pass, live: fresh.live, triggers: fresh.triggers.length, costUsd: fresh.costUsd,
    });
  }

  let interpreterPass = 0;
  const interpreterRows: any[] = [];
  for (const g of interpreterGoldens) {
    const fresh = await interpretRules({ canonical_query: g.question, snapshot });
    if (fresh.live) liveCalls++;
    totalCost += fresh.costUsd;
    const legacy = legacyRules(g.question);
    const pass = sameSet(fresh.appliedRuleIds, g.expectedRules);
    if (pass) interpreterPass++;
    interpreterRows.push({
      id: g.id, question: g.question, expected: g.expectedRules,
      fresh: fresh.appliedRuleIds, freshFilters: fresh.filters, legacy, pass, live: fresh.live, costUsd: fresh.costUsd,
    });
  }

  const summary = {
    mode: liveCalls > 0 ? "live" : "local-fallback (promotion requires live runs)",
    router: `${routerPass}/${routerGoldens.length}`,
    explorer: `${explorerPass}/${explorerGoldens.length}`,
    interpreter: `${interpreterPass}/${interpreterGoldens.length}`,
    totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
  };

  console.log(JSON.stringify({ summary, routerRows, explorerRows, interpreterRows }, null, 2));

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "phase3-shadow.json"),
    JSON.stringify({ runAt: new Date().toISOString(), summary, routerRows, explorerRows, interpreterRows }, null, 2)
  );

  await flushTraces();

  if (routerPass !== routerGoldens.length || explorerPass !== explorerGoldens.length || interpreterPass !== interpreterGoldens.length) {
    process.exitCode = 1;
  }
}

void main();
