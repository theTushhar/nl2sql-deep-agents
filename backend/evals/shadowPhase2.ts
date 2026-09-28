// Shadow comparison for guardrail + debugger.
// Runs the new guardrail analyst + query debugger over the golden sets and
// diffs against LEGACY COPIES of the backend heuristics (comparison only —
// these copies never ship; the new path contains no regex/keyword scans).
// Usage: npm run shadow:phase2   (live LLM when OPENAI_API_KEY is set,
// otherwise the labeled local fallback exercises the full path).
// Promotion requires live runs on real queries approved by you.

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { loadSnapshot } from "../src/config/domain-config";
import { analyzeGuardrail } from "../src/agents/input-guard.agent";
import { normalizeQuery } from "../src/agents/query-normalizer.agent";
import { flushTraces } from "../src/orchestration/observability";

interface GoldenGuardrail {
  id: string;
  question: string;
  expectedVerdict: "allow" | "block";
  expectedIntent: string;
}
interface GoldenDebugger {
  id: string;
  question: string;
  expectedConversational: boolean;
  expectedIntent?: string;
  expectedDomain?: string;
}

// --- LEGACY COPY (backend guardrailNode.ts logic, frozen for comparison) ---
function legacyGuardrail(q: string, rules: { min: number; max: number; keywords: string[]; patterns: string[] }): { blocked: boolean; reason: string } {
  if (q.length < rules.min) return { blocked: true, reason: `Query too short (min ${rules.min})` };
  if (q.length > rules.max) return { blocked: true, reason: `Query too long (max ${rules.max})` };
  const upper = q.toUpperCase();
  for (const kw of rules.keywords) {
    if (upper.includes(kw.toUpperCase())) return { blocked: true, reason: `Blocked keyword: ${kw}` };
  }
  for (const p of rules.patterns) {
    try {
      const re = new RegExp(p.replace(/^\(\?i\)/, ""), "i");
      if (re.test(q)) return { blocked: true, reason: "Injection pattern detected" };
    } catch { /* ignore */ }
  }
  return { blocked: false, reason: "" };
}

// --- LEGACY COPY (backend rephraseNode.ts greeting regex, comparison only) ---
function legacyGreeting(q: string): boolean {
  return /^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|greetings|thanks|thank\s*you)[!.\s]*$/i.test(
    q.trim().toLowerCase()
  );
}

async function main(): Promise<void> {
  if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith("sk-placeholder")) {
    console.log(`[evals] Running in LIVE mode (model: ${process.env.OPENAI_MODEL || "gpt-4o-mini"}). Langfuse tracing: ${process.env.LANGFUSE_ENABLED === "true" ? "ENABLED (" + (process.env.LANGFUSE_BASE_URL || "https://jp.cloud.langfuse.com") + ")" : "DISABLED"}`);
  } else {
    console.warn("[evals] WARNING: OPENAI_API_KEY not configured or placeholder. Running in local fallback mode.");
  }

  const snapshot = loadSnapshot();
  const dir = __dirname + path.sep + "golden";
  const guardGoldens: GoldenGuardrail[] = JSON.parse(fs.readFileSync(path.join(dir, "guardrail.json"), "utf8"));
  const debugGoldens: GoldenDebugger[] = JSON.parse(fs.readFileSync(path.join(dir, "debugger.json"), "utf8"));
  const rules = {
    min: snapshot.staticRules.min_query_length,
    max: snapshot.staticRules.max_query_length,
    keywords: snapshot.staticRules.blocked_keywords,
    patterns: snapshot.staticRules.injection_regex_patterns,
  };

  let liveCalls = 0;
  let guardPass = 0;
  let legacyFalsePositives = 0;
  const guardRows: any[] = [];

  for (const g of guardGoldens) {
    const fresh = await analyzeGuardrail({ question: g.question, snapshot });
    if (fresh.live) liveCalls++;
    const legacy = legacyGuardrail(g.question, rules);
    const legacyVerdict = legacy.blocked ? "block" : "allow";
    const pass = fresh.verdict === g.expectedVerdict && fresh.intent_type === g.expectedIntent;
    if (pass) guardPass++;
    if (legacyVerdict === "block" && g.expectedVerdict === "allow") legacyFalsePositives++;
    guardRows.push({
      id: g.id,
      question: g.question,
      expected: `${g.expectedVerdict}/${g.expectedIntent}`,
      fresh: `${fresh.verdict}/${fresh.intent_type}`,
      legacy: legacyVerdict,
      pass,
      live: fresh.live,
      costUsd: fresh.costUsd,
    });
  }

  let debugPass = 0;
  const debugRows: any[] = [];
  for (const g of debugGoldens) {
    const fresh = await normalizeQuery({ question: g.question, snapshot });
    if (fresh.live) liveCalls++;
    const legacyConv = legacyGreeting(g.question);
    const pass =
      fresh.isConversational === g.expectedConversational &&
      (g.expectedIntent === undefined || fresh.intent === g.expectedIntent) &&
      (g.expectedDomain === undefined || fresh.domain === g.expectedDomain);
    if (pass) debugPass++;
    debugRows.push({
      id: g.id,
      question: g.question,
      expectedConv: g.expectedConversational,
      freshConv: fresh.isConversational,
      freshIntent: fresh.intent,
      freshDomain: fresh.domain,
      canonical: fresh.canonical_query,
      legacyGreeting: legacyConv,
      pass,
      live: fresh.live,
    });
  }

  const summary = {
    mode: liveCalls > 0 ? "live" : "local-fallback (promotion requires live runs)",
    guardrail: { pass: `${guardPass}/${guardGoldens.length}`, legacyFalsePositives },
    debugger: { pass: `${debugPass}/${debugGoldens.length}` },
  };

  console.log(JSON.stringify({ summary, guardRows, debugRows }, null, 2));

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "phase2-shadow.json"),
    JSON.stringify({ runAt: new Date().toISOString(), summary, guardRows, debugRows }, null, 2)
  );

  await flushTraces();

  if (guardPass !== guardGoldens.length || debugPass !== debugGoldens.length) {
    process.exitCode = 1;
  }
}

void main();
