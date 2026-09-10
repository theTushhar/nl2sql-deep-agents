import type { ConfigSnapshot } from "../domain/config";
import { buildCatalogWhitelist } from "../domain/ast-validator";
import { getDomainDefinition } from "../domain/domains";

export type PlanKind = "data_query" | "greeting" | "out_of_scope" | "malicious";

export interface ValidatedPlan {
  kind: PlanKind;
  canonicalQuery: string;
  intent: "filtering" | "aggregation" | "list";
  domain: string;
  relevantEntities: string[];
  selectedFields: Array<{ entity: string; field: string }>;
  appliedRuleIds: string[];
  searchScope: string[];
  aggregation: Record<string, unknown> | null;
  requiredProjection: { field?: string; output?: string; distinct?: boolean } | null;
  warnings: string[];
  unresolved: string[];
}

const RULE_TRIGGERS: Array<{ id: string; re: RegExp }> = [
  { id: "RULE_ACTIVE_TEST_CASES", re: /\b(active|published|committed)\b/i },
  { id: "RULE_DRAFT_TEST_CASES", re: /\b(draft|uncommitted|in[-\s]?progress|work[-\s]?in[-\s]?progress)\b/i },
  { id: "RULE_PERSONAL_TEST_SETS", re: /\b(personal|\bmy\b|\bmine\b)\b/i },
  { id: "RULE_ORPHAN_TEST_SETS", re: /\b(orphan|unlinked|standalone)\b/i },
];

export function filterRulesByQuestion(
  question: string,
  ruleIds: string[],
  snapshot: ConfigSnapshot
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  const known = new Map(snapshot.businessRules.map((r) => [r.id, r]));
  for (const id of ruleIds) {
    const rule = known.get(id);
    if (!rule) {
      dropped.push(id);
      continue;
    }
    if (rule.is_default) {
      kept.push(id);
      continue;
    }
    const trigger = RULE_TRIGGERS.find((t) => t.id === id);
    if (!trigger) {
      kept.push(id);
      continue;
    }
    if (trigger.re.test(question)) kept.push(id);
    else dropped.push(id);
  }
  return { kept, dropped };
}

const AGGREGATION_SIGNALS = /\b(count|having|more than|fewer than|less than|average|avg|sum|group\s+by|top\s+\d+)\b/i;

export function validatePlan(
  raw: unknown,
  ctx: {
    question: string;
    domainHint: string;
    requiredProjection?: { field?: string; output?: string; distinct?: boolean };
    snapshot: ConfigSnapshot;
  }
): { plan: ValidatedPlan } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Planner emitted non-object plan." };
  const p = raw as Record<string, unknown>;

  const kind = (typeof p.kind === "string" ? p.kind : "data_query") as PlanKind;
  if (!["data_query", "greeting", "out_of_scope", "malicious"].includes(kind)) {
    return { error: `Invalid plan kind: ${String(p.kind)}` };
  }

  const canonicalQuery =
    typeof p.canonicalQuery === "string" && p.canonicalQuery.trim().length > 0
      ? p.canonicalQuery.trim()
      : ctx.question;

  let intent: "filtering" | "aggregation" | "list" = "filtering";
  if (p.intent === "aggregation" || p.intent === "list" || p.intent === "filtering") {
    intent = p.intent;
  }
  if (intent !== "aggregation" && AGGREGATION_SIGNALS.test(ctx.question)) {
    intent = "aggregation";
  }

  const warnings: string[] = [];
  let domain = typeof p.domain === "string" && p.domain.trim() ? p.domain.trim().toLowerCase() : ctx.domainHint;
  if (getDomainDefinition(ctx.domainHint) && domain !== ctx.domainHint) {
    warnings.push(`Planner domain '${domain}' overridden by trusted hint '${ctx.domainHint}'.`);
    domain = ctx.domainHint;
  }

  const whitelist = buildCatalogWhitelist(ctx.snapshot);
  const relevantEntities = (Array.isArray(p.relevantEntities) ? p.relevantEntities : [])
    .map((e) => String(e).trim().toUpperCase())
    .filter((e) => whitelist.entities.has(e));

  const selectedFields: Array<{ entity: string; field: string }> = [];
  if (Array.isArray(p.selectedFields)) {
    for (const f of p.selectedFields) {
      if (f && typeof f === "object") {
        const ent = String((f as { entity?: unknown }).entity ?? "").toUpperCase();
        const fld = String((f as { field?: unknown }).field ?? "").toUpperCase();
        if (whitelist.entities.get(ent)?.has(fld)) selectedFields.push({ entity: ent, field: fld });
      }
    }
  }

  const rawRules = Array.isArray(p.appliedRuleIds) ? p.appliedRuleIds.map(String) : [];
  const { kept: appliedRuleIds, dropped } = filterRulesByQuestion(ctx.question, rawRules, ctx.snapshot);
  for (const d of dropped) {
    warnings.push(`Dropped planner rule '${d}': the question carries no trigger for it.`);
  }

  const aggregation =
    p.aggregation && typeof p.aggregation === "object" && !Array.isArray(p.aggregation)
      ? (p.aggregation as Record<string, unknown>)
      : null;

  const requiredProjection = ctx.requiredProjection ?? (p.requiredProjection as any) ?? null;

  return {
    plan: {
      kind,
      canonicalQuery,
      intent,
      domain,
      relevantEntities,
      selectedFields,
      appliedRuleIds,
      searchScope: Array.isArray(p.searchScope) ? p.searchScope.map(String) : [],
      aggregation,
      requiredProjection,
      warnings,
      unresolved: [],
    },
  };
}
