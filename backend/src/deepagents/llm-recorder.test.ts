// Unit tests for the local LLM-call recorder (no network, no LLM).
// Handlers are driven with minimal fakes cast to LangChain callback types.
import { describe, it, expect } from "vitest";
import type { LLMResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import { LlmTraceRecorder } from "./llm-recorder";

class HumanMessage {
  content: string;
  constructor(content: string) {
    this.content = content;
  }
}

class AIMessage {
  content: string;
  constructor(content: string) {
    this.content = content;
  }
}

function messages(text: string): BaseMessage[][] {
  return [
    [new HumanMessage(text) as unknown as BaseMessage],
  ];
}

function output(text: string, usage?: { in: number; out: number }): LLMResult {
  return {
    generations: [[{ text } as unknown as LLMResult["generations"][number][number]]],
    llmOutput: {
      modelName: "gpt-4o-mini",
      ...(usage
        ? {
            tokenUsage: {
              promptTokens: usage.in,
              completionTokens: usage.out,
              totalTokens: usage.in + usage.out,
            },
          }
        : {}),
    },
  } as unknown as LLMResult;
}

const LLM = {} as Serialized;
const TOOL = { name: "task" } as Serialized;

describe("LlmTraceRecorder", () => {
  it("records a coordinator call with prompt, response, and tokens", async () => {
    const rec = new LlmTraceRecorder();
    await rec.handleChatModelStart(LLM, messages("how many test sets?"), "r1");
    await rec.handleLLMEnd(output("SELECT 1", { in: 100, out: 20 }), "r1");
    const drained = rec.drain();
    expect(drained.llmTraces).toHaveLength(1);
    const t = drained.llmTraces[0];
    expect(t.name).toBe("coordinator");
    expect(t.model).toBe("gpt-4o-mini");
    expect(t.prompt).toContain("how many test sets?");
    expect(t.response).toBe("SELECT 1");
    expect(t.promptTokens).toBe(100);
    expect(t.completionTokens).toBe(20);
    expect(t.totalTokens).toBe(120);
    expect(t.live).toBe(true);
    expect(drained.tokensIn).toBe(100);
    expect(drained.tokensOut).toBe(20);
  });

  it("attributes calls inside a task tool to the subagent", async () => {
    const rec = new LlmTraceRecorder();
    await rec.handleToolStart(
      TOOL,
      JSON.stringify({ subagent_type: "sql-writer" }),
      "t1",
      undefined,
      undefined,
      undefined,
      "task"
    );
    await rec.handleChatModelStart(LLM, messages("write sql"), "r1");
    await rec.handleLLMEnd(output("SELECT 2"), "r1");
    await rec.handleToolEnd("done", "t1");
    await rec.handleChatModelStart(LLM, messages("certify"), "r2");
    await rec.handleLLMEnd(output("ok"), "r2");
    const drained = rec.drain();
    expect(drained.llmTraces.map((t) => t.name)).toEqual([
      "sql-writer",
      "coordinator",
    ]);
  });

  it("drops failed calls and keeps completed ones (error path)", async () => {
    const rec = new LlmTraceRecorder();
    await rec.handleChatModelStart(LLM, messages("first"), "r1");
    await rec.handleLLMEnd(output("ok"), "r1");
    await rec.handleChatModelStart(LLM, messages("second"), "r2");
    await rec.handleLLMError(new Error("boom"), "r2");
    const drained = rec.drain();
    expect(drained.llmTraces).toHaveLength(1);
    expect(drained.llmTraces[0].prompt).toContain("first");
  });

  it("drain clears state", async () => {
    const rec = new LlmTraceRecorder();
    await rec.handleChatModelStart(LLM, messages("hi"), "r1");
    await rec.handleLLMEnd(output("hello"), "r1");
    expect(rec.drain().llmTraces).toHaveLength(1);
    expect(rec.drain().llmTraces).toHaveLength(0);
  });

  it("caps recorded calls to bound response size", async () => {
    const rec = new LlmTraceRecorder();
    for (let i = 0; i < 60; i += 1) {
      await rec.handleChatModelStart(LLM, messages(`q${i}`), `r${i}`);
      await rec.handleLLMEnd(output("a"), `r${i}`);
    }
    expect(rec.drain().llmTraces.length).toBeLessThanOrEqual(40);
  });
});
