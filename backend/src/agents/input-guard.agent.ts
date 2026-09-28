// Guardrail analyst subagent.
// Replaces backend guardrailNode.ts keyword/regex code with LLM reasoning.
// Pure reasoning over input + config snapshot: no tools, no regex, no
// keyword scans in code. Length bounds are enforced as a shell budget gate
// and stated as policy facts in the prompt so the model reasons
// about them. Blocked messages are formal and never expose DB internals.
// Prompt text lives in prompts/input-guard.prompt.md (see PROMPTMAP.md); this file
// only computes the {{variables}} and renders.

import { chat, resolveLlmModel } from "../orchestration/llm-client";
import type { ConfigSnapshot } from "../config/domain-config";
import { renderPrompt } from "../prompting/template-loader";

export type GuardrailVerdict = "allow" | "block";
export type GuardrailIntent = "query_data" | "general_chitchat" | "out_of_scope" | "malicious";

export interface GuardrailInput {
  question: string;
  snapshot: ConfigSnapshot;
}

export interface GuardrailOutput {
  verdict: GuardrailVerdict;
  intent_type: GuardrailIntent;
  confidence: number;
  flags: string[];
  /** Safe internal reason. Never rendered verbatim to users. */
  rejection_reason: string | null;
  /** Formal user-facing message for blocked paths. Null when allowed. */
  formalMessage: string | null;
  model: string;
  live: boolean;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

const FORMAL_BLOCK_MESSAGE =
  "Your request cannot be processed as stated. Please rephrase it as a data question about your test sets, test cases, or test runs, avoiding any system or destructive instructions.";

function staticBlockResult(reason: string): GuardrailOutput {
  return {
    verdict: "block",
    intent_type: "malicious",
    confidence: 1.0,
    flags: ["static_injection_gate"],
    rejection_reason: reason,
    formalMessage: FORMAL_BLOCK_MESSAGE,
    model: "static-gate",
    live: false,
    latencyMs: 0,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
}

/** P0-6: deterministic pre-LLM injection gate. Snapshot blocklists were
 *  previously prompt-text only; enforce them in code so a single LLM
 *  misclassification cannot advance to SQL synthesis. Fail-closed. */
function checkStaticInjection(question: string, snapshot: ConfigSnapshot): string | null {
  const lower = question.toLowerCase();
  for (const kw of snapshot.staticRules.blocked_keywords) {
    if (kw && lower.includes(kw.toLowerCase())) return `Blocked keyword: ${kw.trim()}`;
  }
  for (const raw of snapshot.staticRules.injection_regex_patterns) {
    if (!raw) continue;
    try {
      // Snapshot patterns use PCRE `(?i)` prefix; JS RegExp takes an "i" flag.
      const source = raw.replace(/^\(\?i\)/, "");
      if (source && new RegExp(source, "i").test(question)) return "Injection pattern matched.";
    } catch {
      // Ignore malformed patterns — LLM reasoning remains as backstop.
    }
  }
  return null;
}

export async function analyzeGuardrail(input: GuardrailInput): Promise<GuardrailOutput> {
  const { question, snapshot } = input;
  const { staticRules, llmGuard } = snapshot;

  // Shell budget gate: absolute length bounds short-circuit without
  // LLM cost. The same bounds are also given to the model as policy facts.
  if (question.length < staticRules.min_query_length) {
    return {
      verdict: "block",
      intent_type: "out_of_scope",
      confidence: 1.0,
      flags: ["length_policy"],
      rejection_reason: `Query too short (min ${staticRules.min_query_length})`,
      formalMessage:
        "Your request is too short to process. Please provide a complete data question about your test sets, test cases, or test runs.",
      model: "budget-gate",
      live: false,
      latencyMs: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
  }
  if (question.length > staticRules.max_query_length) {
    return {
      verdict: "block",
      intent_type: "out_of_scope",
      confidence: 1.0,
      flags: ["length_policy"],
      rejection_reason: `Query too long (max ${staticRules.max_query_length})`,
      formalMessage:
        "Your request exceeds the maximum supported length. Please shorten it to a focused data question about your test sets, test cases, or test runs.",
      model: "budget-gate",
      live: false,
      latencyMs: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  const staticHit = checkStaticInjection(question, snapshot);
  if (staticHit) return staticBlockResult(staticHit);

  const systemPrompt = renderPrompt("input-guard", {
    snapshot_ref: snapshot.ref,
    min_length: String(staticRules.min_query_length),
    max_length: String(staticRules.max_query_length),
    blocked_keywords: staticRules.blocked_keywords.join(", "),
    allowed_intents: llmGuard.allowed_intent_types.join(", "),
    blocked_intents: llmGuard.blocked_intent_types.join(", "),
  });

  const model = resolveLlmModel("SIMPLE_MODEL", llmGuard.fast_model);
  const res = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    { model, temperature: llmGuard.temperature, spanName: "analyze-guardrail" }
  );

  const parsed = res.parsed || {};
  const intent = (parsed.intent_type as GuardrailIntent) || "query_data";
  const isValid = parsed.is_valid === true && intent === "query_data";
  const malicious = intent === "malicious";

  return {
    verdict: isValid ? "allow" : "block",
    intent_type: ["query_data", "general_chitchat", "out_of_scope", "malicious"].includes(intent)
      ? intent
      : "query_data",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
    rejection_reason: typeof parsed.rejection_reason === "string" ? parsed.rejection_reason : null,
    formalMessage: isValid ? null : malicious ? FORMAL_BLOCK_MESSAGE : null,
    model: res.model,
    live: res.live,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
    tokensIn: res.promptTokens,
    tokensOut: res.completionTokens,
  };
}
