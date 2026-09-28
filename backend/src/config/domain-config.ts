// Config snapshot, file-backed for now, DB-movable shape.
// Values copied from backend/config at scaffold time; the new service reads
// only this snapshot via loadSnapshot(), never backend singletons. Later the
// same shape moves into DB tables and changes without redeploy.

export interface StaticRules {
  min_query_length: number;
  max_query_length: number;
  blocked_keywords: string[];
  injection_regex_patterns: string[];
}

export interface LlmGuard {
  enabled: boolean;
  fast_model: "gpt-4o-mini" | "gpt-4.1-mini";
  temperature: number;
  allowed_intent_types: string[];
  blocked_intent_types: string[];
}

export interface DomainEntry {
  canonical_name: string;
  description: string;
  /** Allowed tables for the domain. Empty means: resolve via schema exploration over all tables. */
  allowedTables: string[];
  subDomains: string[];
  useSchemaFinder: boolean;
}

export interface TableColumn {
  name: string;
  type: string;
  searchable: boolean;
  allowed_values?: string[];
  description?: string;
}

export interface TableJoin {
  target: string;
  on: string;
  type: string;
}

export interface TableEntry {
  table_name: string;
  alias: string;
  description: string;
  primaryKey: string;
  columns: TableColumn[];
  joins: TableJoin[];
}

export interface BusinessRule {
  id: string;
  target_table: string;
  target_column?: string;
  sql_clause: string;
  /** Semantic description. The interpreter LLM reasons from this — there are
   *  deliberately NO trigger terms: substring matching is the brittle
   *  mechanism being retired. */
  description: string;
  /** Default rules apply unless the user explicitly opts out. */
  is_default?: boolean;
}

export interface ConfigSnapshot {
  ref: string;
  /** Dialects the writer can target. Requests for other dialects are blocked formally. */
  supportedDialects: string[];
  staticRules: StaticRules;
  llmGuard: LlmGuard;
  domains: DomainEntry[];
  tables: TableEntry[];
  businessRules: BusinessRule[];
}

export const DEFAULT_SNAPSHOT: ConfigSnapshot = {
  ref: "file-v1",
  supportedDialects: ["mysql", "mssql"],
  staticRules: {
    min_query_length: 2,
    max_query_length: 1500,
    blocked_keywords: [
      "DROP TABLE",
      "DROP DATABASE",
      "TRUNCATE",
      "ALTER TABLE",
      "DELETE FROM",
      "UPDATE ",
      "INSERT INTO",
      "GRANT ALL",
      "REVOKE ALL",
      "EXEC ",
      "EXECUTE ",
      "XP_CMDSHELL",
      "INFORMATION_SCHEMA",
      "BENCHMARK(",
      "SLEEP(",
    ],
    injection_regex_patterns: [
      "(?i)(ignore\\s+(all\\s+)?(previous|prior)\\s+instructions)",
      "(?i)(system\\s+prompt)",
      "(?i)(you\\s+are\\s+now\\s+in\\s+developer\\s+mode)",
      "(?i)(bypass\\s+guardrails?)",
      "(?i)(union\\s+select\\s+.*\\bfrom\\b)",
      "(?i)(--\\s*$)",
      "(?i)(/\\*.*\\*/)",
    ],
  },
  llmGuard: {
    enabled: true,
    fast_model: "gpt-4o-mini",
    temperature: 0.0,
    allowed_intent_types: ["aggregation", "filtering", "list", "query_data"],
    blocked_intent_types: ["malicious", "out_of_scope", "injection", "system_prompt_harvesting"],
  },
  // NOTE: intentionally diverged from backend/config/domains/*.json (backend
  // frozen). Projection guidance lives in domain skill prompts, not here.
  domains: [
    {
      canonical_name: "all_test_sets",
      description:
        "Test-set grid/search queries for finding, listing, or browsing test sets, cases, or steps. Use when the intent is search or browse (includes personal, user-action, API, and UI-locator scopes).",
      allowedTables: ["TEST_SET", "TEST_CASE", "TEST_CASE_STEP"],
      subDomains: ["personal_test_set", "user_action_test_set", "api_test_set", "ui_locator_test_set"],
      useSchemaFinder: false,
    },
    {
      canonical_name: "default",
      description:
        "Fallback for general analytical and multi-column reporting when the question matches no specialized domain. Covers all registered tables via schema exploration; use when the intent is aggregation, comparison, or ad-hoc reporting rather than grid search.",
      allowedTables: [],
      subDomains: [],
      useSchemaFinder: true,
    },
  ],
  tables: [
    {
      table_name: "TEST_SET",
      alias: "ts",
      description: "Test suite container. Groups multiple test cases together for execution.",
      primaryKey: "TEST_SET_UUID",
      columns: [
        { name: "TEST_SET_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "TEST_SET_ID", type: "INT", searchable: false },
        { name: "TEST_SET_NAME", type: "VARCHAR(255)", searchable: true },
        {
          name: "TEST_SET_TYPE",
          type: "VARCHAR(100)",
          searchable: true,
          allowed_values: ["Personal", "User Action", "UI Locator Verification", "API", "User Story", "Feature", "Sub Process"],
        },
        { name: "PAGE_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "VIEW_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "FUNCTIONAL_AREA_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "TEST_SET_OWNER", type: "VARCHAR(36)", searchable: false },
      ],
      joins: [
        { target: "TEST_CASE", on: "ts.TEST_SET_UUID = tc.TEST_SET_UUID", type: "ONE_TO_MANY" },
        { target: "TEST_CASE_STEP", on: "ts.TEST_SET_UUID = tcs.TEST_SET_UUID", type: "ONE_TO_MANY" },
      ],
    },
    {
      table_name: "TEST_CASE",
      alias: "tc",
      description: "Individual test cases belonging to a test set.",
      primaryKey: "TEST_CASE_UUID",
      columns: [
        { name: "TEST_CASE_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "TEST_SET_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "TEST_CASE_ID", type: "INT", searchable: false },
        { name: "TEST_CASE_NAME", type: "VARCHAR(500)", searchable: true },
        { name: "TEST_CASE_SEQ_ID", type: "INT", searchable: false },
        { name: "TEST_CASE_STATUS", type: "VARCHAR(50)", searchable: false },
        { name: "TEST_CASE_EXECUTON_TYPE", type: "VARCHAR(50)", searchable: false },
        { name: "LATEST_RUN_STATUS", type: "VARCHAR(50)", searchable: false },
        { name: "LATEST_RUN_UUID", type: "VARCHAR(36)", searchable: false },
      ],
      joins: [
        { target: "TEST_SET", on: "tc.TEST_SET_UUID = ts.TEST_SET_UUID", type: "MANY_TO_ONE" },
        { target: "TEST_CASE_STEP", on: "tc.TEST_CASE_UUID = tcs.TEST_CASE_UUID", type: "ONE_TO_MANY" },
      ],
    },
    {
      table_name: "TEST_CASE_STEP",
      alias: "tcs",
      description: "Ordered execution steps within a test case. Prefer joining TEST_SET -> TEST_CASE -> TEST_CASE_STEP.",
      primaryKey: "TEST_CASE_STEP_UUID",
      columns: [
        { name: "TEST_CASE_STEP_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "TEST_CASE_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "TEST_SET_UUID", type: "VARCHAR(36)", searchable: false },
        { name: "TEST_CASE_STEP_ID", type: "INT", searchable: false },
        { name: "TEST_CASE_STEP_NAME", type: "VARCHAR(500)", searchable: true, description: "The execution step details or action" },
        { name: "TEST_CASE_STEP_SEQ_ID", type: "INT", searchable: false, description: "The step order or sequence number" },
        { name: "TEST_CASE_STEP_TYPE", type: "VARCHAR(50)", searchable: false, description: "The type of the step" },
        { name: "IS_FUNCTION_STEP", type: "VARCHAR(5)", searchable: false },
        { name: "IS_COMMENTED_STEP", type: "VARCHAR(5)", searchable: false, description: "Whether the step is commented, values 'TRUE'/'FALSE'" },
      ],
      joins: [
        { target: "TEST_CASE", on: "tcs.TEST_CASE_UUID = tc.TEST_CASE_UUID", type: "MANY_TO_ONE" },
        { target: "TEST_SET", on: "tcs.TEST_SET_UUID = ts.TEST_SET_UUID", type: "MANY_TO_ONE" },
      ],
    },
  ],
  businessRules: [
    {
      id: "RULE_ACTIVE_TEST_CASES",
      target_table: "TEST_CASE",
      target_column: "TEST_CASE_STATUS",
      sql_clause: "tc.TEST_CASE_STATUS = 'COMMITTED'",
      description: "Active, committed, or published test cases always map to TEST_CASE_STATUS = 'COMMITTED'.",
    },
    {
      id: "RULE_DRAFT_TEST_CASES",
      target_table: "TEST_CASE",
      target_column: "TEST_CASE_STATUS",
      sql_clause: "tc.TEST_CASE_STATUS = 'DRAFT'",
      description: "Draft, uncommitted, or work-in-progress test cases map to TEST_CASE_STATUS = 'DRAFT'.",
    },
    {
      id: "RULE_EXCLUDE_COMMENTED_STEPS",
      target_table: "TEST_CASE_STEP",
      target_column: "IS_COMMENTED_STEP",
      sql_clause: "(tcs.IS_COMMENTED_STEP != 'Yes' OR tcs.IS_COMMENTED_STEP IS NULL)",
      description:
        "Exclude commented BDD steps by default whenever step data is queried, unless the user explicitly asks for commented steps.",
      is_default: true,
    },
    {
      id: "RULE_ORPHAN_TEST_SETS",
      target_table: "TEST_SET",
      sql_clause: "ts.TEST_SET_TYPE IN ('User Action', 'API') AND ts.API_UUID IS NULL AND ts.USER_ACTION_UUID IS NULL",
      description: "Orphan, unlinked, or standalone test suites are User Action or API suites without linked parent entities.",
    },
    {
      id: "RULE_PERSONAL_TEST_SETS",
      target_table: "TEST_SET",
      sql_clause: "ts.TEST_SET_TYPE = 'Personal'",
      description: "Personal test sets have TEST_SET_TYPE = 'Personal'.",
    },
  ],
};

/** Immutable per-request snapshot read. Subagents never touch the source directly. */
export function loadSnapshot(ref: string = DEFAULT_SNAPSHOT.ref): ConfigSnapshot {
  if (ref !== DEFAULT_SNAPSHOT.ref) {
    throw new Error(`Unknown config snapshot ref: ${ref}`);
  }
  return DEFAULT_SNAPSHOT;
}
