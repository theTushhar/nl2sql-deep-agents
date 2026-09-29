// Shared rich schema block formatter (facts only, no reasoning).
// Used by explorer (context) and writer (generation). Single source so both
// agents always see identical schema text.

import type { ConfigSnapshot } from "./config";

export function buildSchemaBlock(snapshot: ConfigSnapshot, tables: string[]): string {
  const blocks: string[] = [];
  for (const table of tables) {
    const schema = snapshot.tables.find((t) => t.table_name === table);
    if (!schema) continue;
    const colLines = schema.columns.map((c) => {
      const flags: string[] = [];
      if (c.name === schema.primaryKey) flags.push("PRIMARY KEY");
      if (c.searchable) flags.push("SEARCHABLE");
      if (c.allowed_values && c.allowed_values.length > 0) {
        flags.push(`Allowed: ${c.allowed_values.map((v) => `'${v}'`).join(", ")}`);
      }
      return `  - ${c.name} (${c.type})${flags.length > 0 ? ` [${flags.join(", ")}]` : ""} -> Reference as: ${schema.alias}.${c.name}${c.description ? ` - ${c.description}` : ""}`;
    });
    const joinLines = schema.joins.map((j) => `  - JOIN ${j.target} ON ${j.on} (${j.type})`);
    blocks.push(
      `Table: ${schema.table_name} (alias ${schema.alias})\nDescription: ${schema.description}\nColumns (never invent others):\n${colLines.join("\n")}\nValid joins:\n${joinLines.length > 0 ? joinLines.join("\n") : "  - (none)"}`
    );
  }
  return blocks.join("\n\n");
}
