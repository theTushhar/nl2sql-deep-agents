// Single prompt loader: prompts/<stage>.prompt.md is the only wording source.
// loadStagePrompt returns body + shared safety footer (_safety.md).
// Cache is mtime-aware: editing a .prompt.md takes effect on the next call
// without a server restart (dev hot-reload). The deep agent singleton still
// needs a reset to pick up new wording — src/index.ts watches prompts/ in
// non-production and calls resetDeepAgent() on change.
import * as fs from "fs";
import * as path from "path";

const cache = new Map<string, { text: string; mtimeMs: number }>();

function promptsDir(): string {
  // src/agent/prompts.ts -> backend root -> prompts/
  return path.resolve(__dirname, "..", "..", "prompts");
}

function stripFrontmatter(raw: string): string {
  const match = raw.match(/^\uFEFF?---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  return (match?.[1] ?? raw).trim();
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function readBody(name: string): string {
  return stripFrontmatter(fs.readFileSync(path.join(promptsDir(), name), "utf-8"));
}

/** System-prompt body for a stage ("coordinator", "planner", "sql-writer", ...). */
export function loadStagePrompt(stage: string): string {
  const stageFile = path.join(promptsDir(), `${stage}.prompt.md`);
  const safetyFile = path.join(promptsDir(), "_safety.md");
  const stamp = Math.max(mtimeOf(stageFile), mtimeOf(safetyFile));
  const cached = cache.get(stage);
  if (cached && cached.mtimeMs === stamp) return cached.text;
  const body = readBody(`${stage}.prompt.md`).replace(
    /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g,
    "[from task description / tools]"
  );
  const safety = readBody("_safety.md");
  const prompt = safety ? `${body}\n\n${safety}` : body;
  cache.set(stage, { text: prompt, mtimeMs: stamp });
  return prompt;
}

/** Clear memoized prompt bodies (tests / hot-reload). */
export function resetPromptCache(): void {
  cache.clear();
}
