// Deep Agents prompt source.
// prompts/*.prompt.md remain the single source of wording.
// This loader returns the BODY (frontmatter stripped) so each SubAgent's
// systemPrompt is prompt-file owned — code never duplicates wording.
//
// Subagents satisfy former {{variables}} via tools + task description, so
// leftover placeholders are replaced with a tool-direction note instead of
// leaking raw {{…}} tokens into system prompts.

import * as fs from "fs";
import * as path from "path";

const cache = new Map<string, string>();

function promptsDir(): string {
  // src/deepagents/prompts.ts -> backend root -> prompts/
  return path.resolve(__dirname, "..", "..", "prompts");
}

function stripFrontmatter(raw: string): string {
  // Tolerate a UTF-8 BOM (Windows editors reintroduce it on save).
  const match = raw.match(/^\uFEFF?---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  return (match?.[1] ?? raw).trim();
}

/** Raw system-prompt body for a stage (e.g. "input-guard", "sql-writer"). */
export function loadStagePrompt(stage: string): string {
  const cached = cache.get(stage);
  if (cached) return cached;
  const filePath = path.join(promptsDir(), `${stage}.prompt.md`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const body = stripFrontmatter(raw).replace(
    /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g,
    "[from task description / tools]"
  );
  cache.set(stage, body);
  return body;
}
