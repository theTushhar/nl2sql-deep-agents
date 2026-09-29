// Unit tests for the literally-named FinalAnswer echo tool + fallback
// recovery. Offline: tool invoke is local, fallback is pure parsing.
import { describe, it, expect } from "vitest";
import { finalAnswerTool } from "../../../src/agent/schemas";
import { extractFinalAnswerFallback, normalizeFinalAnswer } from "../../../src/agent/coordinator";

const ANSWER = {
  kind: "success",
  sql: "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts",
  ast: null,
  conversationalResponse: null,
  blockedMessage: null,
  error: null,
  domain: "all_test_sets",
  intent: "aggregation",
  complexity: "complex",
  tablesUsed: ["TEST_SET"],
  appliedRuleIds: [],
  measures: [],
  filters: [],
  ordering: [],
  searchScope: [],
  warnings: [],
  unresolved: [],
};

describe("finalAnswerTool", () => {
  it("is bound under the literal name FinalAnswer", () => {
    expect((finalAnswerTool as { name: string }).name).toBe("FinalAnswer");
  });

  it("echoes its input as a JSON string", async () => {
    const out = await (finalAnswerTool as unknown as { invoke: (a: unknown) => Promise<string> }).invoke(ANSWER);
    expect(JSON.parse(out)).toMatchObject({ kind: "success", domain: "all_test_sets" });
  });

  it("accepts sparse args (model omits nulls) for fallback recovery", async () => {
    const sparse = { kind: "success", sql: "SELECT 1", domain: "d", intent: "list", complexity: "simple", tablesUsed: ["T"] };
    const out = await (finalAnswerTool as unknown as { invoke: (a: unknown) => Promise<string> }).invoke(sparse);
    const recovered = extractFinalAnswerFallback({
      messages: [{ content: "", tool_calls: [{ name: "FinalAnswer", args: JSON.parse(out) }] }],
    });
    expect(recovered).toMatchObject({ kind: "success" });
    const normalized = normalizeFinalAnswer(recovered) as Record<string, unknown>;
    expect(normalized.conversationalResponse).toBeNull();
    expect(normalized.warnings).toEqual([]);
  });
});

describe("extractFinalAnswerFallback", () => {
  it("recovers FinalAnswer from echo-tool call args", () => {
    const result = {
      messages: [
        { content: "", tool_calls: [{ name: "FinalAnswer", args: ANSWER }] },
      ],
    };
    expect(extractFinalAnswerFallback(result)).toMatchObject({ kind: "success" });
  });

  it("recovers FinalAnswer from fenced text JSON", () => {
    const result = {
      messages: [{ content: "done\n```json\n" + JSON.stringify(ANSWER) + "\n```" }],
    };
    expect(extractFinalAnswerFallback(result)).toMatchObject({ kind: "success" });
  });

  it("returns null when nothing answer-shaped exists", () => {
    expect(extractFinalAnswerFallback({ messages: [{ content: "thinking…" }] })).toBeNull();
    expect(extractFinalAnswerFallback({})).toBeNull();
  });
});

describe("normalizeFinalAnswer", () => {
  it("fills omitted nulls and arrays, keeps provided values", () => {
    const out = normalizeFinalAnswer({
      kind: "success",
      sql: "SELECT 1",
      domain: "all_test_sets",
      intent: "aggregation",
      complexity: "simple",
      tablesUsed: ["TEST_SET"],
    }) as Record<string, unknown>;
    expect(out.conversationalResponse).toBeNull();
    expect(out.blockedMessage).toBeNull();
    expect(out.error).toBeNull();
    expect(out.ast).toBeNull();
    expect(out.appliedRuleIds).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.sql).toBe("SELECT 1");
  });

  it("passes non-objects through untouched", () => {
    expect(normalizeFinalAnswer(null)).toBeNull();
    expect(normalizeFinalAnswer("x")).toBe("x");
  });
});
