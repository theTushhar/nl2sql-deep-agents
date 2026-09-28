// Query debugger subagent.
// Replaces backend rephraseNode.ts greeting-regex + single-shot LLM with a
// pure-reasoning normalizer: clarifies ambiguity, extracts implicit filters,
// normalizes synonyms, classifies domain, produces a canonical data question.
// No regex, no tools. Conversational replies use a formal, proper tone.
// Prompt text lives in prompts/query-normalizer.prompt.md (see PROMPTMAP.md); this file
// only computes the {{variables}} and renders.

import { chat, resolveLlmModel } from "../orchestration/llm-client";
import type { ConfigSnapshot } from "../config/domain-config";
import { renderPrompt } from "../prompting/template-loader";

export interface DebuggerInput {
  question: string;
  snapshot: ConfigSnapshot;
}

export interface DebuggerOutput {
  isConversational: boolean;
  conversationalResponse: string | null;
  intent: string;
  domain: string;
  canonical_query: string;
  extracted_entities: string[];
  detected_temporal_phrases: string[];
  model: string;
  live: boolean;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export async function normalizeQuery(input: DebuggerInput): Promise<DebuggerOutput> {
  const { question, snapshot } = input;
  const domainList = snapshot.domains
    .map((d) => `- "${d.canonical_name}": ${d.description}`)
    .join("\n");

  const systemPrompt = renderPrompt("query-normalizer", { domain_list: domainList });

  const model = resolveLlmModel("SIMPLE_MODEL", snapshot.llmGuard.fast_model);
  const res = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    { model, temperature: 0.0, spanName: "normalize-query" }
  );

  const parsed = res.parsed || {};
  const canonical = typeof parsed.canonical_query === "string" ? parsed.canonical_query.trim() : "";
  const intent = typeof parsed.intent === "string" ? parsed.intent : "";
  const conversational = intent === "greeting" || intent === "out_of_scope" || !canonical;

  let domain = "default";
  if (!conversational && typeof parsed.domain === "string") {
    const candidate = parsed.domain.trim().toLowerCase();
    const matched = snapshot.domains.find((d) => d.canonical_name.toLowerCase() === candidate);
    domain = matched ? matched.canonical_name : "default";
  }

  return {
    isConversational: conversational,
    conversationalResponse: conversational
      ? typeof parsed.conversational_response === "string" && parsed.conversational_response
        ? parsed.conversational_response
        : "Hello. I am your InfoQA data assistant. Please ask a data question about your test sets, test cases, or test runs."
      : null,
    intent: intent || (conversational ? "greeting" : "filtering"),
    domain,
    canonical_query: conversational ? "" : canonical || question,
    extracted_entities: Array.isArray(parsed.extracted_entities) ? parsed.extracted_entities : [],
    detected_temporal_phrases: Array.isArray(parsed.detected_temporal_phrases)
      ? parsed.detected_temporal_phrases
      : [],
    model: res.model,
    live: res.live,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
    tokensIn: res.promptTokens,
    tokensOut: res.completionTokens,
  };
}
