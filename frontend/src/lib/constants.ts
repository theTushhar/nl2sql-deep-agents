export const STORAGE_KEYS = {
  AUTHENTICATED: "NL2SQL_AUTHENTICATED",
  AUTH_KEY: "NL2SQL_AUTH_KEY",
  API_BASE_URL: "API_BASE_URL",
  API_KEY: "INFOQA_API_KEY",
  DOMAIN: "INFOQA_DOMAIN",
  DIALECT: "INFOQA_DIALECT",
  INCLUDE_TRACES: "INFOQA_INCLUDE_TRACES",
} as const;

export const DOMAIN_OPTIONS = [
  { value: "default", label: "default" },
  { value: "all_test_sets", label: "all_test_sets" },
] as const;

export const DIALECT_OPTIONS = [
  { value: "mysql", label: "mysql" },
  { value: "mssql", label: "mssql" },
] as const;

export const DEFAULT_DOMAIN = "default";
export const DEFAULT_DIALECT = "mysql";
export const DEFAULT_INCLUDE_TRACES = false;

export const STATUS_MESSAGES = {
  CONNECTING: "Connecting to backend...",
  SYNTHESIZING: "Synthesizing SQL query (stateless)...",
} as const;
