// Local per-LLM-call recorder: feeds `include_traces` + token telemetry.
// The Langfuse CallbackHandler has no local aggregation API, so the envelope
// previously reported llmTraces: [], tokens 0, calls 0 — on every path. This
// handler rides the same invoke callbacks and records each chat completion
// (stage-attributed via the `task` delegation stack), so success AND error
// responses carry real per-call traces. Purely local: works with tracing
// disabled, never throws, caps sizes for the 256KB response contract.

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import type { LlmCallTrace } from "../contracts/query-envelope";
import { readModelName } from "./model";

/** Per-field char cap (prompt + response each). */
const MAX_TEXT_CHARS = 1200;
/** Max recorded calls per request (first N win; bounds response size). */
const MAX_CALLS = 40;

interface PendingCall {
  stage: string;
  prompt: string;
  started: number;
}

interface ToolFrame {
  runId: string;
  tool: string;
  subagent: string | null;
}

function trunc(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}…[truncated]`
    : text;
}

function messageRole(m: BaseMessage): string {
  const name =
    (m as unknown as { constructor?: { name?: string } }).constructor?.name ??
    "";
  if (name.startsWith("Human")) return "user";
  if (name.startsWith("AI")) return "assistant";
  if (name.startsWith("System")) return "system";
  if (name.startsWith("Tool")) return "tool";
  return "message";
}

function messageText(m: BaseMessage): string {
  const content = m.content as unknown;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string"
          ? b
          : typeof b === "object" && b !== null && "text" in b
            ? String((b as { text: unknown }).text)
            : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function promptFromMessages(messages: BaseMessage[][]): string {
  const lines: string[] = [];
  for (const group of messages ?? []) {
    for (const m of group ?? []) {
      const text = messageText(m).slice(0, 400);
      if (text) lines.push(`${messageRole(m)}: ${text}`);
    }
  }
  return trunc(lines.join("\n"));
}

/** DeepAgents `task` tool input carries the subagent name; parse defensively. */
function parseTaskSubagent(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    for (const key of ["subagent_type", "subagentType", "name"]) {
      const v = parsed[key];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function tokenUsageOf(output: LLMResult): { in: number; out: number } {
  const usage = (output?.llmOutput as unknown as Record<string, unknown> | undefined)
    ?.tokenUsage as unknown;
  if (typeof usage !== "object" || usage === null) return { in: 0, out: 0 };
  const rec = usage as Record<string, unknown>;
  const promptTokens = typeof rec.promptTokens === "number" ? rec.promptTokens : 0;
  const completionTokens =
    typeof rec.completionTokens === "number" ? rec.completionTokens : 0;
  return { in: promptTokens, out: completionTokens };
}

function modelOf(output: LLMResult): string {
  const llmOutput = output?.llmOutput as unknown as Record<string, unknown> | undefined;
  const name = llmOutput?.modelName ?? llmOutput?.model_name;
  return typeof name === "string" && name ? name : readModelName();
}

function responseTextOf(output: LLMResult): string {
  try {
    const first = output?.generations?.[0]?.[0] as
      | { text?: unknown; message?: BaseMessage }
      | undefined;
    if (typeof first?.text === "string" && first.text) return trunc(first.text);
    if (first?.message) return trunc(messageText(first.message));
    return "";
  } catch {
    return "";
  }
}

export interface DrainedLlm {
  llmTraces: LlmCallTrace[];
  tokensIn: number;
  tokensOut: number;
}

export function emptyLlm(): DrainedLlm {
  return { llmTraces: [], tokensIn: 0, tokensOut: 0 };
}

export class LlmTraceRecorder extends BaseCallbackHandler {
  name = "LlmTraceRecorder";
  private pending = new Map<string, PendingCall>();
  private stack: ToolFrame[] = [];
  private traces: LlmCallTrace[] = [];

  private currentStage(): string {
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const sub = this.stack[i].subagent;
      if (sub) return sub;
    }
    return "coordinator";
  }

  private stash(runId: string, prompt: string): void {
    try {
      if (this.traces.length + this.pending.size >= MAX_CALLS) return;
      this.pending.set(runId, {
        stage: this.currentStage(),
        prompt,
        started: Date.now(),
      });
    } catch {
      // Recording must never break execution
    }
  }

  async handleChatModelStart(
    _llm: Serialized,
    messages: BaseMessage[][],
    runId: string
  ): Promise<void> {
    this.stash(runId, promptFromMessages(messages));
  }

  async handleLLMStart(
    _llm: Serialized,
    prompts: string[],
    runId: string
  ): Promise<void> {
    this.stash(runId, trunc((prompts ?? []).join("\n")));
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    try {
      const call = this.pending.get(runId);
      this.pending.delete(runId);
      if (!call || this.traces.length >= MAX_CALLS) return;
      const tokens = tokenUsageOf(output);
      const total = tokens.in + tokens.out;
      this.traces.push({
        name: call.stage,
        model: modelOf(output),
        prompt: call.prompt,
        response: responseTextOf(output),
        latencyMs: Date.now() - call.started,
        promptTokens: tokens.in,
        completionTokens: tokens.out,
        totalTokens: total,
        live: true,
      });
    } catch {
      // Recording must never break execution
    }
  }

  async handleLLMError(_err: unknown, runId: string): Promise<void> {
    this.pending.delete(runId);
  }

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const toolName = runName || tool?.name || "";
      this.stack.push({
        runId,
        tool: toolName,
        subagent: toolName === "task" ? parseTaskSubagent(input) : null,
      });
    } catch {
      // Recording must never break execution
    }
  }

  private dropFrame(runId: string): void {
    this.stack = this.stack.filter((f) => f.runId !== runId);
  }

  async handleToolEnd(_output: unknown, runId: string): Promise<void> {
    this.dropFrame(runId);
  }

  async handleToolError(_err: unknown, runId: string): Promise<void> {
    this.dropFrame(runId);
  }

  /** Return recorded calls + token sums, then clear (one request, one drain). */
  drain(): DrainedLlm {
    const llmTraces = this.traces;
    this.traces = [];
    this.pending.clear();
    this.stack = [];
    let tokensIn = 0;
    let tokensOut = 0;
    for (const t of llmTraces) {
      tokensIn += t.promptTokens;
      tokensOut += t.completionTokens;
    }
    return { llmTraces, tokensIn, tokensOut };
  }
}

export function createLlmRecorder(): LlmTraceRecorder {
  return new LlmTraceRecorder();
}
