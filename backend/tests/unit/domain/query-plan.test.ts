// Unit tests for deterministic QueryPlan gates. No LLM.
import { describe, it, expect } from "vitest";
import {
  calculateComplexity,
  findMissingRuleClauses,
  findTableDrift,
  hasUndeclaredStatusFilter,
} from "../../../src/domain/query-plan";
import { DEFAULT_SNAPSHOT } from "../../../src/domain/config";

describe("calculateComplexity", () => {
  it("single-table filter is simple", () => {
    expect(calculateComplexity("SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts", ["TEST_SET"])).toBe("simple");
  });
  it("join without aggregation is medium", () => {
    expect(
      calculateComplexity("SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID", [
        "TEST_SET",
        "TEST_CASE",
      ])
    ).toBe("medium");
  });
  it("JOIN + COUNT + GROUP BY + HAVING is complex", () => {
    expect(
      calculateComplexity(
        "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID GROUP BY ts.TEST_SET_UUID HAVING COUNT(tc.TEST_CASE_UUID) > 5",
        ["TEST_SET", "TEST_CASE"]
      )
    ).toBe("complex");
  });
});

describe("findMissingRuleClauses", () => {
  it("flags planner-declared COMMITTED rule absent from SQL", () => {
    const sql =
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID GROUP BY ts.TEST_SET_UUID HAVING COUNT(tc.TEST_CASE_UUID) > 5";
    expect(findMissingRuleClauses(["RULE_ACTIVE_TEST_CASES"], sql, DEFAULT_SNAPSHOT)).toEqual([
      "RULE_ACTIVE_TEST_CASES",
    ]);
  });
  it("passes when the declared clause is present", () => {
    const sql =
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID WHERE tc.TEST_CASE_STATUS = 'COMMITTED' GROUP BY ts.TEST_SET_UUID HAVING COUNT(tc.TEST_CASE_UUID) > 5";
    expect(findMissingRuleClauses(["RULE_ACTIVE_TEST_CASES"], sql, DEFAULT_SNAPSHOT)).toEqual([]);
  });
  it("plain aggregation with no rules is clean", () => {
    const sql =
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID GROUP BY ts.TEST_SET_UUID HAVING COUNT(tc.TEST_CASE_UUID) > 5";
    expect(findMissingRuleClauses([], sql, DEFAULT_SNAPSHOT)).toEqual([]);
  });
});

describe("hasUndeclaredStatusFilter", () => {
  it("warns when SQL invents a status filter", () => {
    expect(
      hasUndeclaredStatusFilter([], "SELECT a FROM t WHERE tc.TEST_CASE_STATUS = 'COMMITTED'")
    ).toBe(true);
  });
  it("quiet when the rule was declared", () => {
    expect(
      hasUndeclaredStatusFilter(["RULE_ACTIVE_TEST_CASES"], "SELECT a FROM t WHERE tc.TEST_CASE_STATUS = 'COMMITTED'")
    ).toBe(false);
  });
});

describe("findTableDrift", () => {
  it("null when declared matches SQL", () => {
    expect(findTableDrift(["TEST_SET", "TEST_CASE"], ["TEST_SET", "TEST_CASE"])).toBeNull();
  });
  it("reports undeclared + unused tables", () => {
    expect(findTableDrift(["TEST_SET"], ["TEST_SET", "TEST_CASE"])).toMatch(/undeclared/);
  });
});
