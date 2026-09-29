// Unit tests for Langfuse span hygiene: noisy plumbing spans are dropped,
// value spans are kept, oversized I/O is truncated. No network, no LLM.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { shouldExportTraceSpan, maskSpanData } from "../../../src/agent/tracing";

function spanNamed(name: string): { otelSpan: ReadableSpan } {
  return { otelSpan: { name } as unknown as ReadableSpan };
}

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["LANGFUSE_EXPORT_NOISY_SPANS", "LANGFUSE_SPAN_IO_MAX_CHARS"]) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete SAVED[k];
  }
});

describe("shouldExportTraceSpan", () => {
  it.each(["RunnableLambda", "__start__", "tools", "model_request", "task"])(
    "drops framework plumbing span %s",
    (name) => {
      expect(shouldExportTraceSpan(spanNamed(name))).toBe(false);
    }
  );

  it.each([
    "ModelCallLimitMiddleware.before_model",
    "ModelCallLimitMiddleware.after_model",
    "ModelCallLimitMiddleware.after_agent",
    "SkillsMiddleware.before_model",
    "FilesystemMiddleware.before_agent",
    "patchToolCallsMiddleware.before_agent",
  ])("drops middleware hook span %s", (name) => {
    expect(shouldExportTraceSpan(spanNamed(name))).toBe(false);
  });

  it.each([
    "deep-agent-run",
    "answer-question-deep",
    "ChatOpenAI",
    "planner",
    "writer",
    "checker",
    "get_table_schema",
    "find_tables",
    "gate:static-certification",
    "gate:ast-validation",
  ])("keeps value span %s", (name) => {
    expect(shouldExportTraceSpan(spanNamed(name))).toBe(true);
  });

  it("escape hatch exports everything when enabled", () => {
    process.env.LANGFUSE_EXPORT_NOISY_SPANS = "true";
    expect(shouldExportTraceSpan(spanNamed("RunnableLambda"))).toBe(true);
    expect(
      shouldExportTraceSpan(spanNamed("SkillsMiddleware.before_model"))
    ).toBe(true);
  });
});

describe("maskSpanData", () => {
  it("passes short strings through untouched", () => {
    expect(maskSpanData({ data: "SELECT 1" })).toBe("SELECT 1");
  });

  it("truncates long strings with a marker", () => {
    const masked = maskSpanData({ data: "x".repeat(5000) }) as string;
    expect(masked.length).toBeLessThan(5000);
    expect(masked).toContain("[truncated");
  });

  it("passes non-strings through untouched", () => {
    expect(maskSpanData({ data: 42 })).toBe(42);
    expect(maskSpanData({ data: null })).toBe(null);
  });

  it("honors LANGFUSE_SPAN_IO_MAX_CHARS", () => {
    process.env.LANGFUSE_SPAN_IO_MAX_CHARS = "10";
    expect(maskSpanData({ data: "0123456789abcdef" })).toBe(
      "0123456789…[truncated 6 chars]"
    );
  });
});
