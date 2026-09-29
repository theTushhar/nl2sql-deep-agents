import { describe, it, expect } from "vitest";
import { QueryAstV2Schema, validateAstLimits, validateAstAggregates, validateAstProjection } from "./query-ast-v2";

const base = {
  version: "2.0",
  root: { entity: "TEST_SET", alias: "ts" },
  projection: { field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, distinct: true, output: "PARENT_UUID" },
} as const;

describe("query-ast-v2 (strict)", () => {
  it("accepts a minimal valid AST", () => {
    expect(QueryAstV2Schema.safeParse(base).success).toBe(true);
  });
  it("rejects unknown keys", () => {
    const parsed = QueryAstV2Schema.safeParse({ ...base, hacked: true });
    expect(parsed.success).toBe(false);
  });
  it("rejects limit without orderBy", () => {
    const parsed = QueryAstV2Schema.safeParse({ ...base, limit: 10 });
    expect(parsed.success).toBe(false);
  });
  it("rejects empty IN values", () => {
    const parsed = QueryAstV2Schema.safeParse({
      ...base,
      where: { kind: "set", field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, operator: "IN", values: [] },
    });
    expect(parsed.success).toBe(false);
  });
  it("flags deep boolean nesting over depth 6", () => {
    let node: unknown = { kind: "comparison", left: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, operator: "EQ", right: { type: "string", value: "x" } };
    const leaf2 = { kind: "comparison", left: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, operator: "EQ", right: { type: "string", value: "y" } };
    for (let i = 0; i < 7; i++) node = { kind: "boolean", operator: "AND", children: [node, leaf2] };
    const ast = { ...base, where: node };
    const parsed = QueryAstV2Schema.safeParse(ast);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(validateAstLimits(parsed.data).length).toBeGreaterThan(0);
  });
  it("rejects single-child boolean groups", () => {
    const parsed = QueryAstV2Schema.safeParse({
      ...base,
      where: {
        kind: "boolean",
        operator: "AND",
        children: [
          { kind: "comparison", left: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, operator: "EQ", right: { type: "string", value: "x" } },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });
  it("rejects aggregates in where, requires groupBy for aggregate having", () => {
    const whereAgg = {
      ...base,
      where: { kind: "comparison", left: { kind: "aggregate", function: "COUNT" }, operator: "GT", right: { type: "number", value: 5 } },
    };
    const pw = QueryAstV2Schema.safeParse(whereAgg);
    expect(pw.success).toBe(true);
    if (pw.success) expect(validateAstAggregates(pw.data).length).toBeGreaterThan(0);
    const havingNoGroup = {
      ...base,
      having: { kind: "comparison", left: { kind: "aggregate", function: "COUNT" }, operator: "GT", right: { type: "number", value: 5 } },
    };
    const ph = QueryAstV2Schema.safeParse(havingNoGroup);
    expect(ph.success).toBe(true);
    if (ph.success) expect(validateAstAggregates(ph.data).length).toBeGreaterThan(0);
    const havingOk = {
      ...base,
      root: { entity: "TEST_CASE", alias: "tc" },
      projection: { field: { kind: "field", alias: "tc", field: "TEST_SET_UUID" }, distinct: true, output: "PARENT_UUID" },
      groupBy: [{ kind: "field", alias: "tc", field: "TEST_SET_UUID" }],
      having: { kind: "comparison", left: { kind: "aggregate", function: "COUNT" }, operator: "GT", right: { type: "number", value: 5 } },
    };
    const pok = QueryAstV2Schema.safeParse(havingOk);
    expect(pok.success).toBe(true);
    if (pok.success) expect(validateAstAggregates(pok.data)).toEqual([]);
  });
  it("requires field for non-COUNT aggregates", () => {
    const parsed = QueryAstV2Schema.safeParse({
      ...base,
      having: { kind: "comparison", left: { kind: "aggregate", function: "SUM" }, operator: "GT", right: { type: "number", value: 1 } },
      groupBy: [{ kind: "field", alias: "ts", field: "TEST_SET_UUID" }],
    });
    expect(parsed.success).toBe(false);
  });
  it("locks TEST_SET_UUID only for single-uuid domains; flexible domains vary", () => {
    const grid = { ...base };
    const pw = QueryAstV2Schema.safeParse(grid);
    expect(pw.success).toBe(true);
    if (pw.success) {
      expect(validateAstProjection(pw.data, { domainColumn: "TEST_SET_UUID" })).toEqual([]);
      expect(
        validateAstProjection(pw.data, { domainColumn: "TEST_SET_UUID", requiredField: "TEST_CASE_UUID" }).length
      ).toBeGreaterThan(0);
    }
    const other = {
      ...base,
      projection: { field: { kind: "field", alias: "tc", field: "TEST_CASE_NAME" }, distinct: true, output: "PARENT_UUID" },
    };
    const po = QueryAstV2Schema.safeParse(other);
    expect(po.success).toBe(true);
    if (po.success) {
      expect(validateAstProjection(po.data, { domainColumn: "TEST_SET_UUID" }).length).toBeGreaterThan(0);
      expect(validateAstProjection(po.data, {})).toEqual([]);
      expect(validateAstProjection(po.data, { requiredField: "TEST_CASE_NAME" })).toEqual([]);
    }
  });
});
