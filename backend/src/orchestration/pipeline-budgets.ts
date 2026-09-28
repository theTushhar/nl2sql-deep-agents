// Budgets stub: llm tier (gpt-4.1-mini / gpt-4o-mini), retry 2-3, sequencing gates.
// TODO: enforce budgets in the orchestration pipeline.
export type LlmModel = "gpt-4.1-mini" | "gpt-4o-mini";

/** @deprecated Use LlmModel. Kept for backward-compatible imports. */
export type CheapModel = LlmModel;

export interface BudgetPolicy {
  modelBySubagent: Record<string, LlmModel>;
  maxWriterCriticRounds: 2 | 3;
}
