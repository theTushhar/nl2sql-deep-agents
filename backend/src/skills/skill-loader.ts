// Skill loader: file-based SKILL.md packs, resolved by name, no versioning.
// Convention: every generation gets `query-writing`;
// domain packs layer by resolved domain; `query-critic` attaches from the
// first retry onward. Unknown names are skipped explicitly and logged.

import * as fs from "fs";
import * as path from "path";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

function parseSkillFile(filePath: string, raw: string): Skill {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  let name = path.basename(path.dirname(filePath));
  let description = "";
  let body = raw;
  if (match) {
    body = match[2] ?? "";
    for (const line of (match[1] ?? "").split("\n")) {
      const nameMatch = line.match(/^\s*name\s*:\s*(.+?)\s*$/);
      if (nameMatch?.[1]) name = nameMatch[1].trim();
      const descMatch = line.match(/^\s*description\s*:\s*(.+?)\s*$/);
      if (descMatch?.[1]) description = descMatch[1].trim();
    }
  }
  return { name, description, body: body.trim() };
}

function skillsRoot(): string {
  // src/skills/skill-loader.ts -> backend root -> skills/
  return path.resolve(__dirname, "..", "..", "skills");
}

const cache = new Map<string, Skill>();

function loadAll(): void {
  cache.clear();
  const root = skillsRoot();
  const groups = ["general", "domains", "critic"];
  for (const group of groups) {
    const groupDir = path.join(root, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(groupDir, entry.name, "SKILL.md");
      if (!fs.existsSync(filePath)) continue;
      try {
        cache.set(
          parseSkillFile(filePath, fs.readFileSync(filePath, "utf-8")).name,
          parseSkillFile(filePath, fs.readFileSync(filePath, "utf-8"))
        );
      } catch (err) {
        console.warn(`[skills] Skipping ${filePath}:`, err);
      }
    }
  }
}

/** Names layered for a generation. Critic attaches from the first retry onward. */
export function resolveSkillsForContext(domain: string, isRetry: boolean): string[] {
  const names = ["query-writing"];
  if (domain.toLowerCase() === "all_test_sets") names.push("all-test-sets");
  if (isRetry) names.push("query-critic");
  return names;
}

/** Render selected skills as a prompt block. Unknown names are skipped. */
export function buildSkillBlock(names: string[]): string {
  if (cache.size === 0) loadAll();
  const blocks: string[] = [];
  for (const name of names) {
    const skill = cache.get(name);
    if (!skill) {
      console.warn(`[skills] Unknown skill skipped: ${name}`);
      continue;
    }
    blocks.push(`## Skill: ${skill.name}\n${skill.description}\n${skill.body}`);
  }
  return blocks.join("\n\n");
}
