// Deep Agents tool layer.
// Wraps the read-only config-snapshot accessors as langchain StructuredTools
// so subagents fetch facts via tool calls (progressive disclosure) instead of
// receiving pre-rendered {{variables}} walls in every system prompt.
// All tools are pure reads over DEFAULT_SNAPSHOT — no writes, no network.

import { z } from "zod";
import { tool } from "langchain";
import { DEFAULT_SNAPSHOT } from "../config/domain-config";
import { buildSchemaBlock } from "../tools/schema-formatter";

const snapshot = DEFAULT_SNAPSHOT;

export const findTablesTool = tool(
  ({ domain }: { domain: string }): string => {
    const entry = snapshot.domains.find((d) => d.canonical_name === domain);
    const tables =
      entry && entry.allowedTables.length > 0
        ? [...entry.allowedTables]
        : snapshot.tables.map((t) => t.table_name);
    return JSON.stringify({ domain, tables });
  },
  {
    name: "find_tables",
    description: "List tables in scope for a domain. Empty allow-list means all tables.",
    schema: z.object({ domain: z.string() }),
  }
);

export const getTableSchemaTool = tool(
  ({ table }: { table: string }): string => {
    const entry = snapshot.tables.find((t) => t.table_name === table);
    if (!entry) return JSON.stringify({ error: `Unknown table: ${table}` });
    return JSON.stringify(entry);
  },
  {
    name: "get_table_schema",
    description: "Get full schema (columns, types, searchable flags, joins) for one table.",
    schema: z.object({ table: z.string() }),
  }
);

export const listSearchableColumnsTool = tool(
  ({ tables }: { tables: string[] }): string => {
    const cols: string[] = [];
    for (const table of tables) {
      const schema = snapshot.tables.find((t) => t.table_name === table);
      if (!schema) continue;
      for (const c of schema.columns) {
        if (c.searchable) cols.push(`${table}.${c.name}`);
      }
    }
    return JSON.stringify({ searchable: cols });
  },
  {
    name: "list_searchable_columns",
    description: "List SEARCHABLE text columns for LIKE/REGEXP predicates. Only these accept text search.",
    schema: z.object({ tables: z.array(z.string()) }),
  }
);

export const listBusinessRulesTool = tool(
  (): string => {
    const rules = snapshot.businessRules.map((r) => ({
      id: r.id,
      target: r.target_column ? `${r.target_table}.${r.target_column}` : r.target_table,
      is_default: r.is_default ?? false,
      description: r.description,
    }));
    return JSON.stringify({ rules });
  },
  {
    name: "list_business_rules",
    description: "List business rules by meaning. Return IDs only; SQL clauses are joined deterministically in code.",
    schema: z.object({}),
  }
);

export const getAllowedValuesTool = tool(
  ({ table, column }: { table: string; column: string }): string => {
    const schema = snapshot.tables.find((t) => t.table_name === table);
    const col = schema?.columns.find((c) => c.name === column);
    return JSON.stringify({ table, column, values: col?.allowed_values ?? [] });
  },
  {
    name: "get_allowed_values",
    description: "Get allowed enum values for a column, if any.",
    schema: z.object({ table: z.string(), column: z.string() }),
  }
);

export const buildSchemaBlockTool = tool(
  ({ tables }: { tables: string[] }): string => {
    return buildSchemaBlock(snapshot, tables);
  },
  {
    name: "build_schema_block",
    description: "Render the rich schema text (columns, aliases, joins) for the given tables. Use before writing SQL.",
    schema: z.object({ tables: z.array(z.string()) }),
  }
);

export const listDomainsTool = tool(
  (): string => {
    const domains = snapshot.domains.map((d) => ({
      canonical_name: d.canonical_name,
      description: d.description,
      subDomains: d.subDomains,
      projection: d.projection,
    }));
    return JSON.stringify({ domains });
  },
  {
    name: "list_domains",
    description: "List registered domains + descriptions + projection contracts for routing and domain rephrasing. Never invent a domain outside this list.",
    schema: z.object({}),
  }
);

/** Minimal read-only set shared by explorer/router/interpreter subagents. */
export const snapshotTools = [
  findTablesTool,
  getTableSchemaTool,
  listSearchableColumnsTool,
  listBusinessRulesTool,
  getAllowedValuesTool,
  buildSchemaBlockTool,
  listDomainsTool,
];
