// P1-5: unit tests for the deterministic SQL gate. Pure function, no LLM.
import { describe, it, expect } from "vitest";
import { runStaticChecks } from "./sql-guardrails";
import { DEFAULT_SNAPSHOT } from "../config/domain-config";

const TABLES = ["TEST_SET", "TEST_CASE", "TEST_CASE_STEP"];

describe("runStaticChecks", () => {
  it("accepts a clean certified SELECT", () => {
    const r = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts",
      TABLES,
      [],
      DEFAULT_SNAPSHOT
    );
    expect(r.errors).toEqual([]);
  });

  it("denies UNION exfiltration", () => {
    const r = runStaticChecks(
      "SELECT ts.TEST_SET_UUID FROM TEST_SET ts UNION SELECT tc.TEST_CASE_UUID FROM TEST_CASE tc",
      TABLES,
      [],
      DEFAULT_SNAPSHOT
    );
    expect(r.errors.some((e) => e.includes("UNION"))).toBe(true);
  });

  it("denies SQL comments", () => {
    const r = runStaticChecks(
      "SELECT ts.TEST_SET_UUID FROM TEST_SET ts -- exfil",
      TABLES,
      [],
      DEFAULT_SNAPSHOT
    );
    expect(r.errors.some((e) => e.toLowerCase().includes("comment"))).toBe(true);
  });

  it("denies time-based functions", () => {
    const r = runStaticChecks("SELECT SLEEP(5)", TABLES, [], DEFAULT_SNAPSHOT);
    expect(r.errors.some((e) => e.includes("Time-based"))).toBe(true);
  });

  it("denies file operations", () => {
    const r = runStaticChecks(
      "SELECT LOAD_FILE('/etc/passwd')",
      TABLES,
      [],
      DEFAULT_SNAPSHOT
    );
    expect(r.errors.some((e) => e.includes("File operations"))).toBe(true);
  });

  it("denies tenant binds", () => {
    const r = runStaticChecks(
      "SELECT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_OWNER = :APP_LOGGED_IN_USER_ID",
      TABLES,
      [],
      DEFAULT_SNAPSHOT
    );
    expect(r.errors.some((e) => e.includes("Bind variable"))).toBe(true);
  });

  it("denies DML and stacked statements", () => {
    const drop = runStaticChecks("DROP TABLE TEST_SET", TABLES, [], DEFAULT_SNAPSHOT);
    expect(drop.errors.length).toBeGreaterThan(0);
    const stacked = runStaticChecks(
      "SELECT ts.TEST_SET_UUID FROM TEST_SET ts; SELECT 1",
      TABLES,
      [],
      DEFAULT_SNAPSHOT
    );
    expect(stacked.errors.some((e) => e.includes("single statement"))).toBe(true);
  });

  it("accepts REGEXP number pattern without LOWER on searchable column", () => {
    const r = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_NAME REGEXP '[0-9]'",
      TABLES,
      [],
      DEFAULT_SNAPSHOT,
      { dialect: "mysql", domain: "all_test_sets" }
    );
    expect(r.errors).toEqual([]);
  });

  it("accepts the incident query: DISTINCT UUID + LOWER() LIKE on searchable", () => {
    const r = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_TYPE = 'Personal' AND (LOWER(ts.TEST_SET_NAME) LIKE 'rock%')",
      TABLES,
      [],
      DEFAULT_SNAPSHOT,
      { dialect: "mysql", domain: "all_test_sets" }
    );
    expect(r.errors).toEqual([]);
  });

  it("denies LOWER() LIKE on non-searchable columns", () => {
    const r = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE LOWER(ts.TEST_SET_OWNER) LIKE '%abc%'",
      TABLES,
      [],
      DEFAULT_SNAPSHOT,
      { dialect: "mysql", domain: "all_test_sets" }
    );
    expect(r.errors.some((e) => e.includes("non-searchable"))).toBe(true);
  });

  it("denies LIKE/REGEXP on non-searchable columns", () => {
    const r = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_OWNER LIKE '%abc%'",
      TABLES,
      [],
      DEFAULT_SNAPSHOT,
      { dialect: "mysql", domain: "all_test_sets" }
    );
    expect(r.errors.some((e) => e.includes("non-searchable"))).toBe(true);
  });

  it("enforces all_test_sets UUID projection", () => {
    const r = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_NAME FROM TEST_SET ts",
      TABLES,
      [],
      DEFAULT_SNAPSHOT,
      { dialect: "mysql", domain: "all_test_sets" }
    );
    expect(r.errors.some((e) => e.includes("all_test_sets"))).toBe(true);
  });

  it("denies REGEXP and LIMIT in mssql rendering", () => {
    const regexp = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_NAME REGEXP '[0-9]'",
      TABLES,
      [],
      DEFAULT_SNAPSHOT,
      { dialect: "mssql", domain: "all_test_sets" }
    );
    expect(regexp.errors.some((e) => e.includes("REGEXP"))).toBe(true);
    const limit = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts LIMIT 10",
      TABLES,
      [],
      DEFAULT_SNAPSHOT,
      { dialect: "mssql", domain: "all_test_sets" }
    );
    expect(limit.errors.some((e) => e.includes("TOP"))).toBe(true);
  });

  it("denies mssql WAITFOR exfiltration", () => {
    const r = runStaticChecks(
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_NAME LIKE '%a%' AND 1=1; WAITFOR DELAY '0:0:5'",
      TABLES,
      [],
      DEFAULT_SNAPSHOT,
      { dialect: "mssql", domain: "all_test_sets" }
    );
    expect(r.errors.some((e) => e.toLowerCase().includes("time-based"))).toBe(true);
  });
});
