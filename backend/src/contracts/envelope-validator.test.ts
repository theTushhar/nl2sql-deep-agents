// P1-5: unit tests for the frozen envelope invariants. No LLM.
import { describe, it, expect } from "vitest";
import { validateEnvelope } from "./envelope-validator";

import type { ProdEnvelope } from "./query-envelope";
function base(): ProdEnvelope {
  return {
    requestEcho: {},
    sql: null,
    dbNeutralQuery: null,
    ast: null,
    dialect: "mysql",
    aiResponse: "Here is your result.",
    filteringMetadata: null,
    warnings: [],
    error: null,
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
      ast: { ast_version: "0.1.0", select: [{ col: "ts.A" }], from: { table: "T", as: "ts" } },
    };
    expect(validateEnvelope(e, "success")).toEqual([]);
  });

  it("rejects malformed v1-clean AST", () => {
    const e = {
      ...base(),
      sql: "SELECT 1",
      dbNeutralQuery: "SELECT 1",
      ast: { ast_version: "0.1.0", select: [], from: { table: "T", as: "ts" } },
    };
    expect(validateEnvelope(e, "success").some((i) => i.path.startsWith("ast."))).toBe(true);
  });

  it("allows ast:null on success when include_ast=false was echoed", () => {
    const e = { ...base(), requestEcho: { include_ast: false }, sql: "SELECT 1", dbNeutralQuery: "SELECT 1", ast: null };
    expect(validateEnvelope(e, "success")).toEqual([]);
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
