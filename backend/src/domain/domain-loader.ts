import * as fs from "fs";
import * as path from "path";

const domainCache = new Map<string, { schema: string; rules: string }>();

function domainsDir(): string {
  return path.resolve(__dirname, "..", "..", "domains");
}

export function loadDomainContext(domain: string): { schema: string; rules: string } {
  const norm = (domain || "default").toLowerCase();
  const cached = domainCache.get(norm);
  if (cached) return cached;

  const dir = path.join(domainsDir(), norm);
  let schema = "";
  let rules = "";

  try {
    const schemaFile = path.join(dir, "schema.md");
    if (fs.existsSync(schemaFile)) schema = fs.readFileSync(schemaFile, "utf-8").trim();
  } catch {
    schema = "";
  }

  try {
    const rulesFile = path.join(dir, "rules.md");
    if (fs.existsSync(rulesFile)) rules = fs.readFileSync(rulesFile, "utf-8").trim();
  } catch {
    rules = "";
  }

  const result = { schema, rules };
  domainCache.set(norm, result);
  return result;
}

export function resetDomainCache(): void {
  domainCache.clear();
}
