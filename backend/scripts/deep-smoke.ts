// deep-smoke — no LLM cost. Verifies the Deep Agents wiring:
// stage prompts load, tools build, subagents build, agent constructs.
import { loadStagePrompt } from "../src/agent/prompts";
import { snapshotTools } from "../src/agent/tools";
import { buildSubagents } from "../src/agent/subagents";
import { getDeepAgent, resetDeepAgent } from "../src/agent/agent";

const stages = [
  "coordinator",
  "planner",
  "sql-writer",
  "ast-writer",
];
for (const stage of stages) {
  const body = loadStagePrompt(stage);
  if (!body || body.length < 50) throw new Error(`Stage prompt empty: ${stage}`);
  console.log(`[deep-smoke] prompt ok: ${stage} (${body.length} chars)`);
}

console.log(`[deep-smoke] tools: ${snapshotTools.map((t) => (t as { name: string }).name).join(", ")}`);

const subs = buildSubagents();
console.log(`[deep-smoke] subagents: ${subs.map((s) => s.name).join(", ")}`);
if (subs.length !== 3) throw new Error(`Expected 3 subagents, got ${subs.length}`);
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
