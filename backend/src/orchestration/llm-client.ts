// Standalone LLM chat wrapper for the deep-agent ecosystem.
// Generic LLM tier (gpt-4.1-mini / gpt-4o-mini). Full Langfuse generations,
// best-effort so key-less dev never breaks. No backend imports.
// Live path uses an OpenAI-compatible /chat/completions endpoint when a key
// is present; otherwise a clearly-labeled LOCAL fallback exercises the full
// path (JSON parsing, envelopes, shadow diffs). Promotion requires live runs.

import type { LlmModel } from "./pipeline-budgets";
import {
  startTrace,
  endTrace,
  startGeneration,
  endGeneration,
  flushTraces,
} from "./observability";

export { startTrace, endTrace, flushTraces };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: LlmModel;
  temperature?: number;
  maxTokens?: number;
  /** Low-cardinality, verb-first Langfuse observation name. Never user text. */
  spanName?: string;
  jsonMode?: boolean;
}

export interface ChatResult {
  content: string;
  parsed: any;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUsd: number;
  model: string;
  /** False when served by the local dev fallback (no key). */
  live: boolean;
}

const LLM_MODELS: LlmModel[] = ["gpt-4o-mini", "gpt-4.1-mini"];

export function resolveLlmModel(envKey: string, fallback: LlmModel): LlmModel {
  const raw = (process.env[envKey] || "").toLowerCase();
  if ((LLM_MODELS as string[]).includes(raw)) return raw as LlmModel;
  return fallback;
}

/** @deprecated Use resolveLlmModel. Kept for backward-compatible imports. */
export const resolveCheapModel = resolveLlmModel;

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const lower = model.toLowerCase();
  let inRate = 0.15 / 1_000_000; // gpt-4o-mini
  let outRate = 0.6 / 1_000_000;
  if (lower.includes("gpt-4.1-mini")) {
    inRate = 0.4 / 1_000_000;
    outRate = 1.6 / 1_000_000;
  }
  const cost = inputTokens * inRate + outputTokens * outRate;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Robust JSON extraction: direct parse, then fenced code-block parse. */
export function extractJson(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const model = options.model || resolveLlmModel("SIMPLE_MODEL", "gpt-4o-mini");
  const spanName = options.spanName || "llm-chat";
  const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || "";
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

  const generation = startGeneration(spanName, model, messages, options.temperature ?? 0.0);
  const startTime = Date.now();
  try {
    let result: ChatResult;
    if (!apiKey || apiKey.startsWith("sk-placeholder") || apiKey === "test-api-key") {
      console.warn(`[llm] OPENAI_API_KEY missing or placeholder. Running in local fallback mode for span '${spanName}'.`);
      result = localFallback(messages, model, startTime, spanName);
    } else {
      const payload: Record<string, any> = {
        model,
        messages,
        temperature: options.temperature ?? 0.0,
      };
      if (options.maxTokens) payload.max_tokens = options.maxTokens;
      if (options.jsonMode !== false) payload.response_format = { type: "json_object" };
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM API error (${res.status} ${res.statusText}): ${errText}`);
      }
      const json = (await res.json()) as any;
      const content = json.choices?.[0]?.message?.content || "";
      const promptTokens = json.usage?.prompt_tokens || 0;
      const completionTokens = json.usage?.completion_tokens || 0;
      const totalTokens = json.usage?.total_tokens || promptTokens + completionTokens;
      result = {
        content,
        parsed: extractJson(content),
        promptTokens,
        completionTokens,
        totalTokens,
        latencyMs: Date.now() - startTime,
        costUsd: calculateCost(model, promptTokens, completionTokens),
        model,
        live: true,
      };
    }
    endGeneration(
      generation,
      result.content,
      result.promptTokens,
      result.completionTokens,
      null,
      result.model,
      result.live
    );
    return result;
  } catch (err) {
    endGeneration(generation, "", 0, 0, err, model, false);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Local dev fallback. NOT for promotion: eval promotion requires live runs
// on real queries. Mirrors expected JSON schemas so the
// full subagent path, envelope assembly, and shadow diffs can run key-less.
// ---------------------------------------------------------------------------
function localFallback(
  messages: ChatMessage[],
  model: string,
  startTime: number,
  spanName: string
): ChatResult {
  const userMsg = messages.find((m) => m.role === "user")?.content || "";
  const lower = userMsg.toLowerCase();
  let obj: any = {};

  if (spanName === "analyze-guardrail") {
    const malicious =
      lower.includes("drop table") ||
      lower.includes("ignore previous") ||
      lower.includes("ignore all previous") ||
      lower.includes("developer mode") ||
      lower.includes("system prompt");
    const chitchat = /^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|greetings|thanks|thank\s*you)[!.\s]*$/i.test(
      userMsg.trim()
    );
    const outOfScope = !malicious && !chitchat && (lower.includes("weather") || lower.includes("football"));
    const intent = malicious ? "malicious" : chitchat ? "general_chitchat" : outOfScope ? "out_of_scope" : "query_data";
    obj = {
      is_valid: !malicious && !outOfScope,
      intent_type: intent,
      confidence: malicious || outOfScope ? 0.95 : 0.9,
      flags: malicious ? ["prompt_injection"] : [],
      rejection_reason: malicious
        ? "Request blocked by policy."
        : outOfScope
          ? "Request is outside supported scope."
          : null,
    };
  } else if (spanName === "normalize-query") {
    const trimmed = userMsg.trim();
    const greeting = /^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|greetings|thanks|thank\s*you)[!.\s]*$/i.test(trimmed);
    const outOfScope = !greeting && (lower.includes("weather") || lower.includes("football"));
    if (greeting || outOfScope || !trimmed) {
      obj = {
        canonical_query: "",
        intent: greeting ? "greeting" : "out_of_scope",
        domain: "default",
        conversational_response:
          "Hello. I am your InfoQA data assistant. Please ask a data question about your test sets, test cases, or test runs, and I will prepare the appropriate query.",
        extracted_entities: [],
        detected_temporal_phrases: [],
      };
    } else {
      obj = {
        canonical_query: trimmed,
        intent: lower.includes("count") || lower.includes("how many") ? "aggregation" : "filtering",
        domain: "all_test_sets",
        conversational_response: null,
        extracted_entities: [],
        detected_temporal_phrases: [],
      };
    }
  } else if (spanName === "route-domain") {
    const personal = lower.includes("personal") || lower.includes("owned by me") || lower.includes("my test");
    const grid =
      lower.includes("test set") ||
      lower.includes("test suite") ||
      lower.includes("globalsqa") ||
      lower.includes("containing") ||
      lower.includes("personal");
    obj = grid
      ? {
          domain_key: "all_test_sets",
          sub_domain_key: personal ? "personal_test_set" : null,
          confidence: 0.9,
          reasoning: "Local fallback classification.",
        }
      : {
          domain_key: "default",
          sub_domain_key: null,
          confidence: 0.85,
          reasoning: "Local fallback classification.",
        };
  } else if (spanName === "explore-schema") {
    const tables: string[] = [];
    if (
      lower.includes("test set") ||
      lower.includes("test_set") ||
      lower.includes("suite") ||
      lower.includes("personal") ||
      lower.includes("globalsqa")
    ) {
      tables.push("TEST_SET");
    }
    if (lower.includes("test case") || lower.includes("test_case") || lower.includes("how many")) {
      if (!tables.includes("TEST_SET")) tables.push("TEST_SET");
      tables.push("TEST_CASE");
    }
    if (lower.includes("step") || lower.includes("bdd") || lower.includes("execution step")) {
      if (!tables.includes("TEST_CASE")) tables.push("TEST_CASE");
      tables.push("TEST_CASE_STEP");
    }
    const finalTables = tables.length > 0 ? tables : ["TEST_SET", "TEST_CASE", "TEST_CASE_STEP"];
    const termMatch = lower.match(/(?:containing|relevant to|like)\s+['"]?([^'"]+)['"]?/);
    const rawTerm = termMatch && termMatch[1] ? termMatch[1].trim() : "";
    const term = rawTerm || (lower.includes("globalsqa") ? "globalsqa" : lower.includes("tushar") ? "tushar" : "");
    obj = {
      relevantTables: finalTables,
      searchScope: term ? ["TEST_SET.TEST_SET_NAME", "TEST_CASE.TEST_CASE_NAME"] : [],
      likePattern: term ? `%${term}%` : null,
      operator: term ? "LIKE" : "NONE",
      complexity: finalTables.length > 1 || term ? "medium" : "simple",
      reasoning: "Local fallback exploration.",
    };
  } else if (spanName === "interpret-rules") {
    const ids: string[] = [];
    if (lower.includes("active") || lower.includes("committed") || lower.includes("published")) {
      ids.push("RULE_ACTIVE_TEST_CASES");
    }
    if (lower.includes("draft") || lower.includes("uncommitted") || lower.includes("wip") || lower.includes("work-in-progress")) {
      ids.push("RULE_DRAFT_TEST_CASES");
    }
    if (lower.includes("personal") || lower.includes("owned by me") || lower.includes("my test")) {
      ids.push("RULE_PERSONAL_TEST_SETS");
    }
    if (lower.includes("orphan") || lower.includes("unlinked") || lower.includes("standalone")) {
      ids.push("RULE_ORPHAN_TEST_SETS");
    }
    if ((lower.includes("step") || lower.includes("bdd")) && !lower.includes("commented")) {
      ids.push("RULE_EXCLUDE_COMMENTED_STEPS");
    }
    obj = {
      appliedRuleIds: ids,
      orderBy: lower.includes("ordered") || lower.includes("order by") ? ["TEST_SET_UUID DESC"] : [],
      measures: lower.includes("status") ? ["LATEST_RUN_STATUS"] : [],
      dimensions: [],
      reasoning: "Local fallback interpretation.",
    };
  } else if (spanName === "generate-sql") {
    // Key-less fallback only: generic certified-safe shape. Live runs only for promotion.
    const content = "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts;";
    return {
      content,
      parsed: { sql: content, confidence: 0.5, tables_used: ["TEST_SET"], explanation: "Local fallback SQL." },
      promptTokens: 50,
      completionTokens: 25,
      totalTokens: 75,
      latencyMs: Date.now() - startTime,
      costUsd: 0,
      model: `${model}+local-fallback`,
      live: false,
    };
  } else if (spanName === "validate-sql") {
    obj = { valid: true, errors: [], warnings: [], critique: "", unresolved: [], usedTables: ["TEST_SET"] };
  } else {
    obj = { echo: userMsg };
  }

  const content = JSON.stringify(obj);
  return {
    content,
    parsed: obj,
    promptTokens: 50,
    completionTokens: 25,
    totalTokens: 75,
    latencyMs: Date.now() - startTime,
    costUsd: 0,
    model: `${model}+local-fallback`,
    live: false,
  };
}

