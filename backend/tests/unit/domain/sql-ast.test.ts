// Unit tests for deterministic sqlToAstV2 (no LLM).
// Covers the canonical grid-filter shape: SELECT DISTINCT uuid + JOIN +
// GROUP BY + HAVING COUNT, plus WHERE text/comparison and unsupported paths.
import { describe, it, expect } from "vitest";
import { sqlToAstV2 } from "../../../src/domain/sql-ast";
import { validateAst, extractSqlTables } from "../../../src/domain/ast-validator";
import { loadSnapshot } from "../../../src/domain/config";

const SNAPSHOT = loadSnapshot();

describe("sqlToAstV2 canonical aggregation", () => {
  it("builds root/projection/join/groupBy/having for the >5 test-cases query", () => {
    const sql =
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts " +
      "JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID " +
      "GROUP BY ts.TEST_SET_UUID HAVING COUNT(tc.TEST_CASE_UUID) > 5";
    const { ast, unsupported } = sqlToAstV2(sql);
    expect(unsupported).toBeUndefined();
    expect(ast).toMatchObject({
      version: "2.0",
      root: { entity: "TEST_SET", alias: "ts" },
      projection: {
        field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" },
        distinct: true,
        output: "PARENT_UUID",
      },
    });
    const checked = validateAst(ast, ["TEST_SET", "TEST_CASE"], SNAPSHOT, extractSqlTables(sql));
    expect(checked.errors).toEqual([]);
    expect(checked.ast).not.toBeNull();
  });

  it("builds a WHERE comparison + LIKE text predicate", () => {
    const sql =
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts " +
      "JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID " +
      "WHERE tc.TEST_CASE_STATUS = 'COMMITTED' AND LOWER(ts.TEST_SET_NAME) LIKE '%login%'";
    const { ast } = sqlToAstV2(sql);
    expect(ast).toMatchObject({ version: "2.0" });
    const checked = validateAst(ast, ["TEST_SET", "TEST_CASE"], SNAPSHOT, extractSqlTables(sql));
    expect(checked.errors).toEqual([]);
  });

  it("marks REGEXP/subquery/OR as unsupported instead of hallucinating", () => {
    expect(sqlToAstV2("SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_NAME REGEXP 'a|b'").ast).toBeNull();
    expect(sqlToAstV2("SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_UUID IN (SELECT 1)").unsupported).toBe("SUBQUERY");
    expect(sqlToAstV2("SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_UUID = 'x' OR ts.TEST_SET_UUID = 'y'").unsupported).toBe("WHERE");
  });
});
