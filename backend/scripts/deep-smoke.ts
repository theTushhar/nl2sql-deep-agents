// deep-smoke — no LLM cost. Verifies the Deep Agents wiring:
// stage prompts load, tools build, subagents build, agent constructs.
import { loadStagePrompt } from "../src/deepagents/prompts";
import { snapshotTools } from "../src/deepagents/tools";
import { buildSubagents } from "../src/deepagents/subagents";
import { getDeepAgent, resetDeepAgent } from "../src/deepagents/agent";

const stages = [
  "input-guard",
  "query-normalizer",
  "domain-router",
  "domain-rephraser",
  "schema-explorer",
  "business-rules",
  "sql-writer",
  "sql-critic",
  "ast-generator",
];
for (const stage of stages) {
  const body = loadStagePrompt(stage);
  if (!body || body.length < 50) throw new Error(`Stage prompt empty: ${stage}`);
  console.log(`[deep-smoke] prompt ok: ${stage} (${body.length} chars)`);
}

console.log(`[deep-smoke] tools: ${snapshotTools.map((t) => (t as { name: string }).name).join(", ")}`);

const subs = buildSubagents();
console.log(`[deep-smoke] subagents: ${subs.map((s) => s.name).join(", ")}`);
if (subs.length !== 9) throw new Error(`Expected 9 subagents, got ${subs.length}`);
for (const s of subs) {
  if (!s.description || !s.systemPrompt || !s.responseFormat) {
    throw new Error(`Subagent incomplete: ${s.name}`);
  }
}

resetDeepAgent();
async function main(): Promise<void> {
  const agent = await getDeepAgent();
  if (!agent) throw new Error("getDeepAgent returned null");
  console.log("[deep-smoke] agent constructed (no LLM call made).");
  console.log("[deep-smoke] all checks passed.");
}
main().catch((err) => {
  console.error("[deep-smoke] FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
