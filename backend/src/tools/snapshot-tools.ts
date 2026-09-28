// Registry tools: pure, read-only data accessors over a config snapshot.
// No keyword scoring, no regex, no substring matching — those brittle
// mechanisms are retired. Subagent LLMs do the reasoning; these tools only
// supply facts. Every invocation is recorded on a per-request tracker for
// the org audit requirement.

import type { ConfigSnapshot, TableEntry } from "../config/domain-config";

export interface TriggerRecord {
  name: string;
  outcome: string;
}

export interface Tracker {
  record(name: string, outcome: string): void;
  list(): TriggerRecord[];
}

export function createTracker(): Tracker {
  const records: TriggerRecord[] = [];
  return {
    record(name: string, outcome: string): void {
      records.push({ name, outcome });
    },
    list(): TriggerRecord[] {
      return [...records];
    },
  };
}

function track(tracker: Tracker | undefined, name: string, outcome: string): void {
  if (tracker) tracker.record(name, outcome);
}

function allTableNames(snapshot: ConfigSnapshot): string[] {
  return snapshot.tables.map((t) => t.table_name);
}

/** Tables in scope for a domain. Empty allowedTables means: all tables. */
export function findTables(
  snapshot: ConfigSnapshot,
  domain: string,
  tracker?: Tracker
): string[] {
  const entry = snapshot.domains.find((d) => d.canonical_name === domain);
  const tables = entry && entry.allowedTables.length > 0 ? [...entry.allowedTables] : allTableNames(snapshot);
  track(tracker, "findTables", `domain=${domain} tables=${tables.join(",")}`);
  return tables;
}

export function getTableSchema(
  snapshot: ConfigSnapshot,
  table: string,
  tracker?: Tracker
): TableEntry {
  const entry = snapshot.tables.find((t) => t.table_name === table);
  if (!entry) {
    track(tracker, "getTableSchema", `table=${table} outcome=unknown-table`);
    throw new Error(`Unknown table: ${table}`);
  }
  track(tracker, "getTableSchema", `table=${table} columns=${entry.columns.length}`);
  return entry;
}

export function listSearchableColumns(
  snapshot: ConfigSnapshot,
  tables: string[],
  tracker?: Tracker
): string[] {
  const cols: string[] = [];
  for (const table of tables) {
    const schema = snapshot.tables.find((t) => t.table_name === table);
    if (!schema) continue;
    for (const c of schema.columns) {
      if (c.searchable) cols.push(`${table}.${c.name}`);
    }
  }
  track(tracker, "listSearchableColumns", `tables=${tables.join(",")} searchable=${cols.length}`);
  return cols;
}

export function getAllowedValues(
  snapshot: ConfigSnapshot,
  table: string,
  column: string,
  tracker?: Tracker
): string[] {
  const schema = snapshot.tables.find((t) => t.table_name === table);
  const col = schema?.columns.find((c) => c.name === column);
  const values = col?.allowed_values || [];
  track(tracker, "getAllowedValues", `column=${table}.${column} values=${values.length}`);
  return [...values];
}

/** All business rules with semantic descriptions. No trigger terms by design. */
export function listBusinessRules(snapshot: ConfigSnapshot, tracker?: Tracker) {
  track(tracker, "listBusinessRules", `rules=${snapshot.businessRules.length}`);
  return snapshot.businessRules.map((r) => ({ ...r }));
}

/**
 * Deterministic relative-date resolution. The backend TimeResolver is a stub
 * returning null, so this preserves parity: always null for now. Temporal
 * phrases flow through as debugger/interpreter metadata until Phase 4.
 */
export function resolveTimeRange(
  _phrase: string,
  tracker?: Tracker
): { timeFilter: string | null } {
  track(tracker, "resolveTimeRange", "outcome=stub-null (parity with backend)");
  return { timeFilter: null };
}

/**
 * Org-controlled safe search. Stub returning no rows until the search backend
 * is approved and connected. Never fabricates document hits.
 */
export function searchDocuments(
  _scope: string[],
  _term: string,
  tracker?: Tracker
): { hits: unknown[] } {
  track(tracker, "searchDocuments", "outcome=stub-empty (no search backend connected)");
  return { hits: [] };
}
