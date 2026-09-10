export function failureMarker(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cls =
    err instanceof Error
      ? String(err.constructor?.name ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "Error"
      : "Error";
  if (/timed out after/i.test(msg)) return "AGENT_FAILED (AGENT_TIMEOUT)";
  if (/model call limit/i.test(msg)) return "AGENT_FAILED (LLM_CALL_BUDGET_EXCEEDED)";
  if (/recursion/i.test(msg)) return "AGENT_FAILED (AGENT_RECURSION_LIMIT)";
  if (/final answer failed validation/i.test(msg)) return "AGENT_FAILED (FINAL_ANSWER_VALIDATION_FAILED)";
  if (/invalid schema|status.?400/i.test(msg)) return "AGENT_FAILED (LLM_SCHEMA_ERROR)";
  return `AGENT_FAILED (AGENT_INVOCATION_FAILED:${cls})`;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  const candidates = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace?.[0] && brace[0] !== text) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue candidate parsing
    }
  }
  return null;
}

export function normalizeFinalAnswer(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of ["sql", "ast", "conversationalResponse", "blockedMessage", "error", "reasonCode"]) {
    if (out[k] === undefined) out[k] = null;
  }
  for (const k of [
    "tablesUsed",
    "appliedRuleIds",
    "measures",
    "filters",
    "ordering",
    "searchScope",
    "warnings",
    "unresolved",
  ]) {
    if (out[k] === undefined) out[k] = [];
  }
  return out;
}

function messageTextOf(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
          return (c as { text: string }).text;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function toolCallArgsOf(msg: unknown): unknown[] {
  if (!msg || typeof msg !== "object") return [];
  const calls = (msg as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(calls)) {
    return calls.map((c: unknown) => (c && typeof c === "object" ? (c as { args?: unknown }).args : undefined));
  }
  return [];
}

export function extractFinalAnswerFallback(result: unknown): unknown | null {
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    for (const args of toolCallArgsOf(messages[i])) {
      const obj = asObject(args);
      if (obj && typeof obj.kind === "string") return obj;
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const obj = asObject(messageTextOf(messages[i]));
    if (obj && typeof obj.kind === "string") return obj;
  }
  return null;
}
