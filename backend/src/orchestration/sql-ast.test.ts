// P1-5: unit tests for the v1-clean AST tool. No LLM.
import { describe, it, expect } from "vitest";
import { buildAst, buildAstTool, tablesUsedFromAst, AST_VERSION } from "./sql-ast";

describe("buildAstTool (v1-clean)", () => {
  it("parses a simple filtered query", () => {
    const ast = buildAst(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_TYPE = 'Personal'"
    );
    expect(ast).toMatchObject({
      ast_version: AST_VERSION,
      select: [{ col: "ts.TEST_SET_UUID", distinct: true }],
      from: { table: "TEST_SET", as: "ts" },
      where: { col: "ts.TEST_SET_TYPE", op: "=", val: "Personal" },
    });
    expect(ast).not.toHaveProperty("joins");
    expect(ast).not.toHaveProperty("limit");
  });

  it("parses joins, group_by, order_by, limit and COUNT", () => {
    const ast = buildAst(
      "SELECT ts.TEST_SET_UUID, COUNT(tc.TEST_CASE_UUID) AS case_count FROM TEST_SET ts " +
        "INNER JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID " +
        "WHERE ts.TEST_SET_TYPE = 'Personal' " +
        "GROUP BY ts.TEST_SET_UUID ORDER BY case_count DESC LIMIT 50"
    );
    expect(ast?.joins).toEqual([
      { type: "INNER", table: "TEST_CASE", as: "tc", on: "ts.TEST_SET_UUID=tc.TEST_SET_UUID" },
    ]);
    expect(ast?.group_by).toEqual(["ts.TEST_SET_UUID"]);
    expect(ast?.order_by).toEqual([{ col: "case_count", dir: "DESC" }]);
    expect(ast?.limit).toBe(50);
    expect(tablesUsedFromAst(ast!)).toEqual(["TEST_SET", "TEST_CASE"]);
  });

  it("falls back to {raw} instead of dropping unknown predicates", () => {
    const ast = buildAst("SELECT ts.A FROM T ts WHERE SOMEFUNC(ts.A, 1, 2)");
    expect(ast?.where).toMatchObject({ raw: expect.any(String) });
  });

  it("returns null only when no FROM exists", () => {
    expect(buildAst("")).toBeNull();
    expect(buildAst("SELECT 1")).toBeNull();
  });

  it("records the tool trigger", () => {
    const seen: Array<{ name: string; outcome: string }> = [];
    const tracker = { record: (n: string, o: string) => void seen.push({ name: n, outcome: o }), list: () => [...seen] };
    buildAstTool("SELECT ts.A FROM T ts", tracker);
    expect(seen.some((t) => t.name === "buildAst" && t.outcome.startsWith("ok"))).toBe(true);
  });
});
