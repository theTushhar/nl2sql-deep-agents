// Unit tests for request validation (input caps + AST options). No LLM.
import { describe, it, expect } from "vitest";
import {
  QueryRequestSchema,
  getEffectiveQuery,
  getEffectiveRequiredProjection,
  getEffectiveTimeContext,
} from "./query-request.schema";

describe("QueryRequestSchema", () => {
  it("accepts query with defaults", () => {
    const r = QueryRequestSchema.safeParse({ query: "hi" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.domain).toBe("default");
  });

  it("accepts ast options (required_projection, time_context)", () => {
    const r = QueryRequestSchema.safeParse({
      query: "show test sets",
      required_projection: { field: "TEST_SET_UUID", output: "PARENT_UUID", distinct: true },
      time_context: { time_zone: "Asia/Calcutta", now: "2026-09-25T15:30:00+05:30", week_starts_on: "MONDAY" },
    });
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
  it("returns the trimmed query", () => {
    expect(getEffectiveQuery({ query: "  show test sets  ", domain: "default" })).toBe("show test sets");
  });

  it("ignores Swagger placeholder 'string'", () => {
    expect(getEffectiveQuery({ query: "string", domain: "default" })).toBeNull();
  });

  it("returns null when blank", () => {
    expect(getEffectiveQuery({ query: "   ", domain: "default" })).toBeNull();
  });
});

describe("AST request options", () => {
  it("reads required_projection, ignores unknown alias keys", () => {
    expect(
      getEffectiveRequiredProjection({ required_projection: { field: "TEST_SET_UUID" } } as never)?.field
    ).toBe("TEST_SET_UUID");
    expect(getEffectiveRequiredProjection({ requiredProjection: { field: "X" } } as never)).toBeUndefined();
    expect(getEffectiveRequiredProjection({} as never)).toBeUndefined();
  });

  it("reads time_context, ignores unknown alias keys", () => {
    expect(getEffectiveTimeContext({ time_context: { time_zone: "Asia/Calcutta" } } as never)?.time_zone).toBe(
      "Asia/Calcutta"
    );
    expect(getEffectiveTimeContext({ timeContext: { time_zone: "UTC" } } as never)).toBeUndefined();
    expect(getEffectiveTimeContext({} as never)).toBeUndefined();
  });

  it("ignores camelCase include_ast alias", () => {
    const r = QueryRequestSchema.safeParse({ query: "hi", includeAst: false });
    expect(r.success).toBe(true);
  });
});
