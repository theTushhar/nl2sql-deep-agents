import * as fs from "fs";
import * as path from "path";

export interface PromptTemplate {
  name: string;
  body: string;
  metadata: Record<string, string>;
  mtimeMs: number;
}

/**
 * Tunable per-prompt config, all editable in the `.prompt.md` frontmatter.
 * Code never hardcodes wording, model choice, or temperature — it reads
 * them here so prompt owners can tune without touching `.agent.ts`.
 *
 * Frontmatter keys (all optional except `name`):
 *   name, version, owner, used_by, when, description,
 *   model_env (env var to read, always LLM_MODEL), model_fallback,
 *   temperature, json_mode (true/false), variables (comma list)
 */
export interface PromptConfig {
  name: string;
  version: string;
  owner: string;
  usedBy: string;
  when: string;
  description: string;
  modelEnv: string;
  modelFallback: string;
  temperature: number;
  jsonMode: boolean;
  variables: string[];
}

const templateCache = new Map<string, PromptTemplate>();

function promptsDir(): string {
  // src/prompting/template-loader.ts -> backend root -> prompts/
  return path.resolve(__dirname, "..", "..", "prompts");
}

function resolvePromptFile(name: string): string {
  // Canonical only: prompts/<stage>.prompt.md (matches src/agent/agent.ts and subagents.ts).
  return path.join(promptsDir(), `${name}.prompt.md`);
}

function parsePromptFile(filePath: string): PromptTemplate {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, "utf-8");
  // Tolerate a UTF-8 BOM (Windows editors reintroduce it on save).
  const match = raw.match(/^\uFEFF?---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
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


/** Read tunable config for a prompt (model, temperature, json mode). Never throws on missing keys — falls back to safe defaults. */
export function getPromptConfig(name: string): PromptConfig {
  const template = loadPromptTemplate(name);
  const m = template.metadata;
  const parseTemp = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw === undefined) return fallback;
    return /^(true|1|yes)$/i.test(raw.trim());
  };
  const parseList = (raw: string | undefined): string[] => {
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  };
  return {
    name: m.name || template.name,
    version: m.version || "1.0",
    owner: m.owner || "",
    usedBy: m.used_by || "",
    when: m.when || "",
    description: m.description || "",
    modelEnv: m.model_env || "LLM_MODEL",
    modelFallback: m.model_fallback || "gpt-4o-mini",
    temperature: parseTemp(m.temperature, 0.0),
    jsonMode: parseBool(m.json_mode, true),
    variables: parseList(m.variables),
  };
}

/** List all registered prompt names (file scan, no cache side-effects beyond load). */
export function listPromptNames(): string[] {
  const dir = promptsDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".prompt.md"))
      .map((f) => f.replace(/\.prompt\.md$/, ""));
  } catch {
    return [];
  }
}

/**
 * Validate that all `{{variables}}` used in the body are declared in
 * frontmatter `variables:` and supplied by the caller. Returns issues
 * (empty = ok). Used by `npm run prompts:check` — no LLM cost.
 */
export function validatePrompt(name: string, supplied: Record<string, unknown> = {}): string[] {
  const template = loadPromptTemplate(name);
  const issues: string[] = [];
  const used = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template.body)) !== null) {
    if (m[1]) used.add(m[1]);
  }
  const declared = new Set(getPromptConfig(name).variables);
  for (const v of used) {
    if (!declared.has(v)) issues.push(`Variable {{${v}}} used in body but missing from frontmatter variables:`);
  }
  for (const v of Object.keys(supplied)) {
    if (!used.has(v) && !declared.has(v)) issues.push(`Supplied variable "${v}" is not used by prompt "${name}".`);
  }
  return issues;
}
