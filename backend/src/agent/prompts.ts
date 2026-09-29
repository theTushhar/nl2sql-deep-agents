// Single prompt loader: prompts/<stage>.prompt.md is the only wording source.
// loadStagePrompt returns body + shared safety footer (_safety.md).
import * as fs from "fs";
import * as path from "path";

const cache = new Map<string, string>();

function promptsDir(): string {
  // src/agent/prompts.ts -> backend root -> prompts/
  return path.resolve(__dirname, "..", "..", "prompts");
}

function stripFrontmatter(raw: string): string {
  const match = raw.match(/^\uFEFF?---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  return (match?.[1] ?? raw).trim();
}

function readBody(name: string): string {
  return stripFrontmatter(fs.readFileSync(path.join(promptsDir(), name), "utf-8"));
}

/** System-prompt body for a stage ("coordinator", "planner", "writer", "checker"). */
export function loadStagePrompt(stage: string): string {
  const cached = cache.get(stage);
  if (cached) return cached;
  const body = readBody(`${stage}.prompt.md`).replace(
    /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g,
    "[from task description / tools]"
  );
  const safety = readBody("_safety.md");
  const prompt = safety ? `${body}\n\n${safety}` : body;
  cache.set(stage, prompt);
  return prompt;
}
