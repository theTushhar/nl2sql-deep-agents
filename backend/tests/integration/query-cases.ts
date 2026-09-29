// Query eval registry: representative NL questions + expected SQL shapes.
// ADD NEW QUERIES HERE — the runner (query-eval.ts) picks them up with no
// other changes. Matching is on normalized SQL (uppercase, collapsed
// whitespace), so `contains` fragments must be written UPPERCASE.
//
// Conventions (agreed 2026-09-29, domain all_test_sets):
// - name search ("contains X") targets TEST_SET_NAME only, single table.
// - "personal test sets" means TEST_SET_TYPE = 'Personal'.
// - test-step questions still project the parent TEST_SET_UUID (single-uuid
//   contract); the `default` domain is the one that returns row details.
// - ID lookups are single-table: no JOINs, no default status rules.

export interface ExpectedSql {
  /** Normalized-SQL fragments that MUST appear (uppercase). */
  contains: string[];
  /** Normalized-SQL fragments that MUST NOT appear (uppercase). */
  notContains?: string[];
  /** Exact table set (order-insensitive) detected in FROM/JOIN. */
  tables?: string[];
}

export interface QueryCase {
  name: string;
  query: string;
  domain: string;
  dialect?: string;
  expectKind?: "success" | "blocked" | "conversational";
  expectedSql?: ExpectedSql;
  /** Expect a non-null AST v2 object in the envelope (default true on success). */
  expectAst?: boolean;
}

export const QUERY_CASES: QueryCase[] = [
  {
    name: "globalsqa-name-search",
    query: "give me all the test sets which contains globalsqa",
    domain: "all_test_sets",
    expectKind: "success",
    expectedSql: {
      contains: ["TEST_SET_UUID", "TEST_SET_NAME", "LIKE", "%GLOBAL"],
      notContains: ["JOIN"],
      tables: ["TEST_SET"],
    },
    expectAst: true,
  },
  {
    name: "personal-test-sets",
    query: "give me all the personal test sets",
    domain: "all_test_sets",
    expectKind: "success",
    expectedSql: {
      contains: ["TEST_SET_UUID", "TEST_SET_TYPE", "'PERSONAL'"],
      notContains: ["JOIN"],
      tables: ["TEST_SET"],
    },
    expectAst: true,
  },
  {
    name: "tushar-step-search",
    query: "give me the test step where test case name contains tushar",
    domain: "all_test_sets",
    expectKind: "success",
    expectedSql: {
      contains: ["TEST_SET_UUID", "TEST_CASE_NAME", "LIKE", "%TUSHAR%", "TEST_CASE_STEP"],
      tables: ["TEST_SET", "TEST_CASE", "TEST_CASE_STEP"],
    },
    expectAst: true,
  },
  {
    name: "testset-id-39902",
    query: "Give me all the testsets having id 39902",
    domain: "all_test_sets",
    expectKind: "success",
    expectedSql: {
      contains: ["TEST_SET_UUID", "TEST_SET_ID", "39902"],
      notContains: ["JOIN"],
      tables: ["TEST_SET"],
    },
    expectAst: true,
  },
  {
    name: "testset-id-339009",
    query: "give me all the test sets having id 339009",
    domain: "all_test_sets",
    expectKind: "success",
    expectedSql: {
      contains: ["TEST_SET_UUID", "TEST_SET_ID", "339009"],
      notContains: ["JOIN"],
      tables: ["TEST_SET"],
    },
    expectAst: true,
  },
  {
    // Regression for the >5 test-cases trace: aggregation over join, and NO
    // implicit COMMITTED status filter (plain "test cases" selects no rule).
    name: "testsets-more-than-five-cases",
    query: "show test sets having more than five test cases",
    domain: "default",
    expectKind: "success",
    expectedSql: {
      contains: ["TEST_SET_UUID", "COUNT", "GROUP BY", "HAVING", "> 5"],
      notContains: ["COMMITTED", "DRAFT"],
      tables: ["TEST_SET", "TEST_CASE"],
    },
    expectAst: true,
  },
];
