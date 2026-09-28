import * as fs from "fs";
import * as path from "path";

export interface PromptTemplate {
  name: string;
  body: string;
  metadata: Record<string, string>;
  mtimeMs: number;
}

const templateCache = new Map<string, PromptTemplate>();

function promptsDir(): string {
  // src/prompting/template-loader.ts -> backend root -> prompts/
  return path.resolve(__dirname, "..", "..", "prompts");
}

function resolvePromptFile(name: string): string {
  const dir = promptsDir();
  // Canonical: prompts/<stage>.prompt.md (matches src/agents/<stage>.agent.ts).
  // Legacy fallback: prompts/<stage>.md (pre-rename files).
  const candidates = [path.join(dir, `${name}.prompt.md`), path.join(dir, `${name}.md`)];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) return filePath;
  }
  return candidates[0] as string;
}

function parsePromptFile(filePath: string): PromptTemplate {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, "utf-8");
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  const metadata: Record<string, string> = {};
  let body = raw;

  if (match) {
    const frontmatter = match[1] ?? "";
    body = (match[2] ?? "").trim();
    for (const line of frontmatter.split("\n")) {
      const kvMatch = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.+?)\s*$/);
      if (kvMatch && kvMatch[1]) {
        metadata[kvMatch[1].trim()] = (kvMatch[2] ?? "").trim();
      }
    }
  }

  const name = metadata.name || path.basename(filePath, ".md");
  return { name, body, metadata, mtimeMs: stat.mtimeMs };
}

export function loadPromptTemplate(name: string): PromptTemplate {
  const filePath = resolvePromptFile(name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`[prompts] Prompt file not found: ${filePath}`);
  }

  const cached = templateCache.get(name);
  if (cached) {
    // Check mtime for instant reload when editing markdown
    try {
      const currentStat = fs.statSync(filePath);
      if (currentStat.mtimeMs === cached.mtimeMs) {
        return cached;
      }
    } catch {
      // Ignore stat error and use cached
      return cached;
    }
  }

  const parsed = parsePromptFile(filePath);
  templateCache.set(name, parsed);
  return parsed;
}

export function getPrompt(
  name: string,
  variables: Record<string, unknown> = {}
): string {
  const template = loadPromptTemplate(name);
  let rendered = template.body;

  for (const [key, val] of Object.entries(variables)) {
    let replacement = "";
    if (val === null || val === undefined) {
      replacement = "";
    } else if (Array.isArray(val)) {
      replacement = val.join(", ");
    } else {
      replacement = String(val);
    }
    const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g");
    rendered = rendered.replace(regex, replacement);
  }

  return rendered;
}

export const renderPrompt = getPrompt;
