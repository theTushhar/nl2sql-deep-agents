// P1-5: unit tests for the frozen envelope invariants. No LLM.
import { describe, it, expect } from "vitest";
import { validateEnvelope } from "../../../src/contracts/envelope-validator";

import type { ProdEnvelope } from "../../../src/contracts/query-envelope";
function base(): ProdEnvelope {
  return {
    sql: null,
    dbNeutralQuery: null,
    ast: null,
    dialect: "mysql",
    aiResponse: "Here is your result.",
    filteringMetadata: null,
    warnings: [],
    error: null,
    reasonCode: null,
    unresolved: [],
    telemetry: {},
    meta: {},
  };
}

describe("validateEnvelope", () => {
  it("rejects non-success kinds carrying SQL", () => {
    const e = { ...base(), sql: "SELECT 1" };
    expect(validateEnvelope(e, "blocked").length).toBeGreaterThan(0);
    expect(validateEnvelope(e, "conversational").length).toBeGreaterThan(0);
  });

  it("rejects success without certified SQL", () => {
    expect(validateEnvelope(base(), "success").length).toBeGreaterThan(0);
    const e = {
      ...base(),
      sql: "SELECT 1",
      dbNeutralQuery: "SELECT 1",
      ast: {
        version: "2.0",
        root: { entity: "TEST_SET", alias: "ts" },
        projection: { field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, distinct: true, output: "PARENT_UUID" },
      },
    };
    expect(validateEnvelope(e, "success")).toEqual([]);
  });

  it("rejects malformed v2 AST", () => {
    const e = {
      ...base(),
      sql: "SELECT 1",
      dbNeutralQuery: "SELECT 1",
      ast: { version: "2.0", root: { entity: "T", alias: "ts" } },
    };
    expect(validateEnvelope(e, "success").some((i) => i.path.startsWith("ast."))).toBe(true);
  });

  it("rejects v1-clean AST (v2-only contract)", () => {
    const e = {
      ...base(),
      sql: "SELECT 1",
      dbNeutralQuery: "SELECT 1",
      ast: { ast_version: "0.1.0", select: [{ col: "ts.A" }], from: { table: "T", as: "ts" } },
    };
    expect(validateEnvelope(e, "success").some((i) => i.path.startsWith("ast."))).toBe(true);
  });

  it("requires reasonCode on unsupported and clarification_required", () => {
    const u = { ...base(), sql: "SELECT 1", dbNeutralQuery: "SELECT 1", ast: null, reasonCode: null as string | null };
    expect(validateEnvelope(u, "unsupported").some((i) => i.path === "reasonCode")).toBe(true);
    const u2 = { ...u, reasonCode: "UNSUPPORTED_OPERATION" };
    expect(validateEnvelope(u2, "unsupported")).toEqual([]);
    const c = { ...base(), sql: null, ast: null, reasonCode: "CLARIFICATION_REQUIRED" };
    expect(validateEnvelope(c, "clarification_required")).toEqual([]);
  });

  it("allows ast:null on success when the caller opted out via include_ast=false", () => {
    const e = { ...base(), sql: "SELECT 1", dbNeutralQuery: "SELECT 1", ast: null };
    expect(validateEnvelope(e, "success", { includeAst: false })).toEqual([]);
    expect(validateEnvelope(e, "success").some((i) => i.path === "ast")).toBe(true);
  });

  it("accepts conversational null-SQL", () => {
    expect(validateEnvelope(base(), "conversational")).toEqual([]);
  });

  it("flags leaked internals in user text", () => {
    const e = { ...base(), aiResponse: "the password is abc" };
    expect(
      validateEnvelope(e, "conversational").some((i) => i.message.includes("leaks"))
    ).toBe(true);
  });
});
