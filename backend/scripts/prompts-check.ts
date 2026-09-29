// prompts:check — no LLM cost. Validates every prompts/*.prompt.md:
// frontmatter has name/owner/variables + body {{variables}} match declarations.
import { listPromptNames, loadPromptTemplate, getPromptConfig, validatePrompt } from "../src/prompting/template-loader";

const REQUIRED_META = ["name", "owner", "variables"];
let failed = 0;
for (const name of listPromptNames()) {
  const template = loadPromptTemplate(name);
  const cfg = getPromptConfig(name);
  const missing = REQUIRED_META.filter((k) => !template.metadata[k]);
  if (missing.length > 0) {
    console.error(`[prompts:check] ${name}: missing frontmatter: ${missing.join(", ")}`);
    failed++;
    continue;
  }
  const issues = validatePrompt(name);
  if (issues.length > 0) {
    console.error(`[prompts:check] ${name}:`);
    for (const i of issues) console.error(`  - ${i}`);
    failed++;
    continue;
  }
  console.log(`[prompts:check] ok: ${name} (v${cfg.version}, model_env=${cfg.modelEnv}, temp=${cfg.temperature}, json=${cfg.jsonMode})`);
}
if (failed > 0) {
  console.error(`[prompts:check] ${failed} prompt(s) failed.`);
  process.exit(1);
}
console.log("[prompts:check] all prompts valid.");
