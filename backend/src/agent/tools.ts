// Deep Agents tool layer.
// Wraps the read-only config-snapshot accessors as langchain StructuredTools
// so subagents fetch facts via tool calls (progressive disclosure) instead of
// receiving pre-rendered {{variables}} walls in every system prompt.
// All tools are pure reads over DEFAULT_SNAPSHOT — no writes, no network.

import { z } from "zod";
import { tool } from "langchain";
import { DEFAULT_SNAPSHOT } from "../domain/config";
import { buildSchemaBlock } from "../domain/schema-formatter";

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
  ({ domain }: { domain?: string }): string => {
    // Strict partition: a caller planning for one domain sees ONLY that
    // domain's rules. Omitting the domain returns everything (back-compat
    // for callers with no domain context yet).
    const wanted = (domain || "").toLowerCase();
    const rules = snapshot.businessRules
      .filter((r) => !wanted || r.domain.toLowerCase() === wanted)
      .map((r) => ({
        id: r.id,
        domain: r.domain,
        target: r.target_column ? `${r.target_table}.${r.target_column}` : r.target_table,
        is_default: r.is_default ?? false,
        description: r.description,
      }));
    return JSON.stringify({ rules });
  },
  {
    name: "list_business_rules",
    description: "List business rules for ONE domain (pass the planner domain). Returns only that domain's rules. Return IDs only; SQL clauses are joined deterministically in code.",
    schema: z.object({ domain: z.string().optional() }),
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
      // Skill packs the writer must load for this domain (progressive
      // disclosure: names only here; bodies load on demand via SkillsMiddleware).
      skills: d.skills,
    }));
    return JSON.stringify({ domains });
  },
  {
    name: "list_domains",
    description: "List registered domains + descriptions + projection contracts + skill packs. Never invent a domain outside this list.",
    schema: z.object({}),
  }
);

/**
 * Single-call context for the writer happy path: domain tables +
 * full schemas + searchable columns + that domain's rules + the rendered
 * schema block, in one tool result instead of 4-5 sequential round-trips.
 * Planner/checker keep the granular tools; the writer prefers this one.
 */
export const getContextTool = tool(
  ({ domain, tables }: { domain: string; tables: string[] }): string => {
    const wanted = (domain || "").toLowerCase();
    // Compact schemas: name/type/searchable/allowed_values/description only —
    // full join arrays live in buildSchemaBlock consumers; the writer joins
    // via the schema block paths, so per-table joins are omitted here to
    // avoid shipping the same column list twice (schemas + schemaBlock).
    const schemas = tables.map((table) => {
      const entry = snapshot.tables.find((t) => t.table_name === table);
      if (!entry) return { error: `Unknown table: ${table}` };
      return {
        table_name: entry.table_name,
        alias: entry.alias,
        primaryKey: entry.primaryKey,
        columns: entry.columns.map((c) => ({
          name: c.name,
          type: c.type,
          searchable: c.searchable,
          ...(c.allowed_values ? { allowed_values: c.allowed_values } : {}),
        })),
      };
    });
    const searchable: string[] = [];
    for (const table of tables) {
      const schema = snapshot.tables.find((t) => t.table_name === table);
      if (!schema) continue;
      for (const c of schema.columns) {
        if (c.searchable) searchable.push(`${table}.${c.name}`);
      }
    }
    const rules = snapshot.businessRules
      .filter((r) => !wanted || r.domain.toLowerCase() === wanted)
      .map((r) => ({
        id: r.id,
        domain: r.domain,
        target: r.target_column ? `${r.target_table}.${r.target_column}` : r.target_table,
        is_default: r.is_default ?? false,
        description: r.description,
      }));
    return JSON.stringify({
      domain,
      tables,
      schemas,
      searchable,
      rules,
    });
  },
  {
    name: "get_context",
    description:
      "Get everything needed to write SQL for a domain in ONE call: table schemas, searchable columns, that domain's business rules, and the rendered schema block. Prefer this over list_domains/get_table_schema/build_schema_block sequences.",
    schema: z.object({ domain: z.string(), tables: z.array(z.string()) }),
  }
);

/** Minimal read-only set shared by the planner/writer/checker subagents. */
export const snapshotTools = [
  findTablesTool,
  getTableSchemaTool,
  listSearchableColumnsTool,
  listBusinessRulesTool,
  getAllowedValuesTool,
  buildSchemaBlockTool,
  listDomainsTool,
  getContextTool,
];
