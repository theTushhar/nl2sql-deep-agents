// Model identity for the deep-agents runtime — docs-idiomatic form.
// createDeepAgent receives a model ID string ("provider:model"); langchain
// resolves it via initChatModel (API key + base URL come from the standard
// OPENAI_API_KEY / OPENAI_BASE_URL env vars). Single model for the main agent
// and every subagent (subagents omit `model` and inherit it).
//
// NOTE: there is intentionally NO createLlmModel()/ChatOpenAI factory here.
// Passing a pre-built model instance bypasses the docs path and drifts from
// the Deep Agents spec — the agent owns model resolution from this string.

export const DEFAULT_MODEL = "gpt-4o-mini" as const;

/** Bare model name from env (`LLM_MODEL`), e.g. "gpt-4o-mini". */
export function readModelName(): string {
  return (process.env.LLM_MODEL || "").trim() || DEFAULT_MODEL;
}

/** Model ID from env (`LLM_MODEL`), e.g. "openai:gpt-4o-mini" or "anthropic:claude-3-7-sonnet". */
export function resolveModelId(): string {
  const model = readModelName();
  return model.includes(":") ? model : `openai:${model}`;
}
