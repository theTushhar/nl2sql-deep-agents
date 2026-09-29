import { describe, it, expect } from "vitest";
import {
  repairAstStructure,
  extractSqlTables,
  extractAstTables,
  validateSqlAgreement,
} from "./ast";
import { DEFAULT_SNAPSHOT } from "../config/domain-config";

describe("ast-generator SQL-first derivation", () => {
  it("extracts SQL tables from FROM and JOIN clauses", () => {
    expect(
      extractSqlTables(
        "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID WHERE LOWER(tc.TEST_CASE_NAME) LIKE '%rock%'"
      )
    ).toEqual(["TEST_SET", "TEST_CASE"]);
  });
  it("accepts AST tables matching the certified SQL", () => {
    const ast = {
      version: "2.0",
      root: { entity: "TEST_SET", alias: "ts" },
      projection: { field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, distinct: true, output: "PARENT_UUID" },
      joins: [
        {
          type: "INNER",
          entity: "TEST_CASE",
          alias: "tc",
          on: [
            { left: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, right: { kind: "field", alias: "tc", field: "TEST_SET_UUID" } },
          ],
        },
      ],
    } as Parameters<typeof extractAstTables>[0];
    expect(extractAstTables(ast)).toEqual(["TEST_SET", "TEST_CASE"]);
    expect(validateSqlAgreement(ast, ["TEST_SET", "TEST_CASE"])).toEqual([]);
  });
  it("flags AST tables drifting from the certified SQL", () => {
    const ast = {
      version: "2.0",
      root: { entity: "TEST_SET", alias: "ts" },
      projection: { field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, distinct: true, output: "PARENT_UUID" },
      joins: [
        {
          type: "INNER",
          entity: "TEST_CASE_STEP",
          alias: "tcs",
          on: [
            { left: { kind: "field", alias: "tc", field: "TEST_CASE_UUID" }, right: { kind: "field", alias: "tcs", field: "TEST_CASE_UUID" } },
          ],
        },
      ],
    } as Parameters<typeof extractAstTables>[0];
    const issues = validateSqlAgreement(ast, ["TEST_SET", "TEST_CASE"]);
    expect(issues.length).toBeGreaterThan(0);
  });
  it("repairs missing join type, object on, TABLE placeholder, binary kind", () => {
    const candidate = {
      version: "2.0",
      root: { entity: "TEST_SET", alias: "ts" },
      projection: { field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, distinct: true, output: "PARENT_UUID" },
      joins: [{ entity: "TABLE", alias: "tc", on: { left: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, right: { kind: "field", alias: "tc", field: "TEST_SET_UUID" } } }],
      where: { kind: "binary", left: { kind: "field", alias: "tc", field: "TEST_CASE_NAME" }, operator: "CONTAINS", right: { type: "string", value: "globalsqa" } },
    };
    const { repaired } = repairAstStructure(candidate, ["TEST_SET", "TEST_CASE"], DEFAULT_SNAPSHOT);
    const joins = repaired.joins as Array<Record<string, unknown>>;
    expect(joins[0]?.type).toBe("INNER");
    expect(Array.isArray(joins[0]?.on)).toBe(true);
    expect(joins[0]?.entity).toBe("TEST_CASE");
    expect((repaired.where as Record<string, unknown>).kind).toBe("text");
  });
  it("prunes joins to tables neither required nor referenced", () => {
    const candidate = {
      version: "2.0",
      joins: [
        { type: "INNER", entity: "TEST_CASE", alias: "tc", on: [{ left: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, right: { kind: "field", alias: "tc", field: "TEST_SET_UUID" } }] },
        { type: "INNER", entity: "TEST_CASE_STEP", alias: "tcs", on: [{ left: { kind: "field", alias: "tc", field: "TEST_CASE_UUID" }, right: { kind: "field", alias: "tcs", field: "TEST_CASE_UUID" } }] },
      ],
      where: { kind: "text", field: { kind: "field", alias: "tc", field: "TEST_CASE_NAME" }, operator: "CONTAINS", value: "globalsqa" },
    };
    const { repaired } = repairAstStructure(candidate, ["TEST_SET", "TEST_CASE"], DEFAULT_SNAPSHOT);
    const joins = repaired.joins as Array<Record<string, unknown>>;
    expect(joins.length).toBe(1);
    expect(joins[0]?.entity).toBe("TEST_CASE");
  });
});
