// Domain router subagent.
// Replaces keyword-based domain guessing with LLM reasoning over the
// registered domain list. Output validated against the snapshot: unknown
// domain keys fall back to "default", unknown sub-domains to null.
// Prompt text lives in prompts/domain-router.prompt.md (see PROMPTMAP.md); this file
// only computes the {{variables}} and renders.

import { chat, resolveLlmModel } from "../orchestration/llm-client";
import type { ConfigSnapshot } from "../config/domain-config";
import { renderPrompt } from "../prompting/template-loader";

export interface RouterInput {
  canonical_query: string;
  snapshot: ConfigSnapshot;
}

export interface RouterOutput {
  domain_key: string;
  sub_domain_key: string | null;
  confidence: number;
  reasoning: string;
  model: string;
  live: boolean;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export async function routeDomain(input: RouterInput): Promise<RouterOutput> {
  const { canonical_query, snapshot } = input;
  const domainList = snapshot.domains
    .map(
      (d) =>
        `- "${d.canonical_name}": ${d.description}` +
        (d.subDomains.length > 0 ? ` Sub-domains: ${d.subDomains.join(", ")}.` : "")
    )
    .join("\n");

  const systemPrompt = renderPrompt("domain-router", { domain_list: domainList });

  const model = resolveLlmModel("SIMPLE_MODEL", snapshot.llmGuard.fast_model);
  const res = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: canonical_query },
    ],
    { model, temperature: 0.0, spanName: "route-domain" }
  );

  const parsed = res.parsed || {};
  const candidate = typeof parsed.domain_key === "string" ? parsed.domain_key.trim().toLowerCase() : "";
  const matched = snapshot.domains.find((d) => d.canonical_name.toLowerCase() === candidate);
  const domain_key = matched ? matched.canonical_name : "default";

  let sub_domain_key: string | null = null;
  if (matched && typeof parsed.sub_domain_key === "string" && parsed.sub_domain_key) {
    const sub = parsed.sub_domain_key.trim();
    sub_domain_key = matched.subDomains.includes(sub) ? sub : null;
  }

  return {
    domain_key,
    sub_domain_key,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    model: res.model,
    live: res.live,
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
    tokensIn: res.promptTokens,
    tokensOut: res.completionTokens,
  };
}
