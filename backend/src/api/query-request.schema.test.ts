// P1-5: unit tests for request validation (P0-10 input caps). No LLM.
import { describe, it, expect } from "vitest";
import { QueryRequestSchema, getEffectiveQuery } from "./query-request.schema";

describe("QueryRequestSchema", () => {
  it("accepts query with defaults", () => {
    const r = QueryRequestSchema.safeParse({ query: "hi" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.domain).toBe("default");
  });

  it("accepts legacy nl_query alias", () => {
    const r = QueryRequestSchema.safeParse({ nl_query: "hi" });
    expect(r.success).toBe(true);
  });

  it("rejects oversized query (P0-10 cap)", () => {
    const r = QueryRequestSchema.safeParse({ query: "x".repeat(2000) });
    expect(r.success).toBe(false);
  });

  it("rejects oversized ids", () => {
    const r = QueryRequestSchema.safeParse({ query: "hi", thread_id: "t".repeat(200) });
    expect(r.success).toBe(false);
  });
});

describe("getEffectiveQuery", () => {
  it("prefers query over nl_query over question", () => {
    expect(
      getEffectiveQuery({ query: "b", nl_query: "a", question: "c", domain: "default" })
    ).toBe("b");
    expect(getEffectiveQuery({ nl_query: "a", question: "c", domain: "default" })).toBe("a");
    expect(getEffectiveQuery({ question: "c", domain: "default" })).toBe("c");
  });

  it("ignores Swagger placeholder 'string'", () => {
    expect(getEffectiveQuery({ query: "string", domain: "default" })).toBeNull();
  });

  it("returns null when blank", () => {
    expect(getEffectiveQuery({ query: "   ", domain: "default" })).toBeNull();
  });
});
