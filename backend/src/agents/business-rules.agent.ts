// Business-rule interpreter subagent.
// Replaces parallelNode.ts trigger-term substring matching with LLM reasoning
// over semantic rule descriptions. The model selects rule IDs only — the shell
// joins the corresponding sql_clause values deterministically, so no SQL
// fragment can ever be hallucinated into the filter list.
// Prompt text lives in prompts/business-rules.prompt.md (see PROMPTMAP.md); this file
// only computes the {{variables}} and renders.

import { chat, resolveLlmModel } from "../orchestration/llm-client";
import type { ConfigSnapshot } from "../config/domain-config";
import { createTracker, listBusinessRules, type TriggerRecord } from "../tools/snapshot-tools";
import { renderPrompt } from "../prompting/template-loader";

export interface InterpreterInput {
  canonical_query: string;
  snapshot: ConfigSnapshot;
}

export interface InterpreterOutput {
  appliedRuleIds: string[];
  filters: string[];
  orderBy: string[];
  measures: string[];
  dimensions: string[];
  reasoning: string;
  triggers: TriggerRecord[];
  model: string;
  live: boolean;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export async function interpretRules(input: InterpreterInput): Promise<InterpreterOutput> {
  const { canonical_query, snapshot } = input;
  const tracker = createTracker();
  const rules = listBusinessRules(snapshot, tracker);

  const ruleList = rules
    .map(
      (r) =>
        `- "${r.id}" [${r.target_table}${r.target_column ? `.${r.target_column}` : ""}]${r.is_default ? " (DEFAULT rule)" : ""}: ${r.description}`
    )
    .join("\n");

  const systemPrompt = renderPrompt("business-rules", { rule_list: ruleList });

  const model = resolveLlmModel("SIMPLE_MODEL", snapshot.llmGuard.fast_model);
  const res = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: canonical_query },
    ],
    { model, temperature: 0.0, spanName: "interpret-rules" }
  );

  const parsed = res.parsed || {};
  const knownIds = new Set(rules.map((r) => r.id));
  const appliedRuleIds = Array.isArray(parsed.appliedRuleIds)
    ? parsed.appliedRuleIds.filter((id: unknown) => typeof id === "string" && knownIds.has(id))
    : [];

  // Deterministic join: filters are exactly the clauses of applied rules.
  const filters = appliedRuleIds.map((id: string) => rules.find((r) => r.id === id)?.sql_clause || "");

  tracker.record("interpret-rules", `applied=${appliedRuleIds.join(",") || "(none)"}`);

  return {
    appliedRuleIds,
    filters: filters.filter((f: string) => f !== ""),
    orderBy: Array.isArray(parsed.orderBy) ? parsed.orderBy.filter((o: unknown) => typeof o === "string") : [],
    measures: Array.isArray(parsed.measures) ? parsed.measures.filter((m: unknown) => typeof m === "string") : [],
    dimensions: Array.isArray(parsed.dimensions)
      ? parsed.dimensions.filter((d: unknown) => typeof d === "string")
      : [],
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    triggers: tracker.list(),
    model: res.model,
    live: res.live,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
    tokensIn: res.promptTokens,
    tokensOut: res.completionTokens,
  };
}
