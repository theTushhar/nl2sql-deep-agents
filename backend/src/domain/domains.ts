export interface JoinPath {
  fromEntity: string;
  fromAlias: string;
  toEntity: string;
  toAlias: string;
  type: "INNER" | "LEFT";
  on: Array<{ left: { alias: string; field: string }; right: { alias: string; field: string } }>;
}

export interface RequiredProjection {
  field: string;
  output: "PARENT_UUID";
  distinct: true;
}

export interface DomainRule {
  id: string;
  category: "projection" | "structural" | "business" | "safety";
  description: string;
}

export interface DomainDefinition {
  name: string;
  version: string;
  description: string;
  allowedEntities: string[];
  allowedJoinPaths: JoinPath[];
  requiredProjection?: RequiredProjection;
  rules: DomainRule[];
  skills: string[];
  capabilities: string[];
}

const ALL_TEST_SETS_JOINS: JoinPath[] = [
  {
    fromEntity: "TEST_SET",
    fromAlias: "ts",
    toEntity: "TEST_CASE",
    toAlias: "tc",
    type: "INNER",
    on: [{ left: { alias: "ts", field: "TEST_SET_UUID" }, right: { alias: "tc", field: "TEST_SET_UUID" } }],
  },
  {
    fromEntity: "TEST_CASE",
    fromAlias: "tc",
    toEntity: "TEST_CASE_STEP",
    toAlias: "tcs",
    type: "LEFT",
    on: [{ left: { alias: "tc", field: "TEST_CASE_UUID" }, right: { alias: "tcs", field: "TEST_CASE_UUID" } }],
  },
];

export const DOMAIN_REGISTRY: DomainDefinition[] = [
  {
    name: "all_test_sets",
    version: "1.0",
    description: "Test-set grid/search screen. Pinned projection to parent UUID.",
    allowedEntities: ["TEST_SET", "TEST_CASE", "TEST_CASE_STEP"],
    allowedJoinPaths: ALL_TEST_SETS_JOINS,
    requiredProjection: { field: "TEST_SET_UUID", output: "PARENT_UUID", distinct: true },
    rules: [
      { id: "PROJ_SINGLE_UUID_DISTINCT", category: "projection", description: "Project exactly one DISTINCT parent UUID." },
      { id: "STRUCT_ALLOWED_ENTITIES_ONLY", category: "structural", description: "Use only TEST_SET, TEST_CASE, TEST_CASE_STEP with legal join paths." },
      { id: "RULE_ACTIVE_TEST_CASES", category: "business", description: "Apply only when user explicitly asks for active/committed/published cases." },
      { id: "RULE_DRAFT_TEST_CASES", category: "business", description: "Apply only when user explicitly asks for draft/in-progress cases." },
      { id: "SAFETY_READ_ONLY", category: "safety", description: "Read-only SELECT only; never invent identity predicates." },
    ],
    skills: ["all-test-sets"],
    capabilities: ["grid-search", "parent-uuid-projection"],
  },
  {
    name: "default",
    version: "1.0",
    description: "Generic analytical/reporting domain over the full catalog.",
    allowedEntities: [],
    allowedJoinPaths: [],
    rules: [
      { id: "STRUCT_CATALOG_ONLY", category: "structural", description: "Reject unknown entities, fields, aliases, and joins." },
      { id: "SAFETY_READ_ONLY", category: "safety", description: "Read-only SELECT only; never invent identity predicates." },
    ],
    skills: ["default-reporting"],
    capabilities: ["ad-hoc-reporting", "aggregation"],
  },
];

export const CATALOG_REF = "file-v1";

export function getDomainDefinition(name: string): DomainDefinition | undefined {
  const lower = (name || "default").toLowerCase();
  return DOMAIN_REGISTRY.find((d) => d.name.toLowerCase() === lower);
}

export function getPromptVersions(domain: string): Record<string, string> {
  const def = getDomainDefinition(domain);
  return {
    coordinator: "2.0",
    planner: "2.0",
    sqlWriter: "1.0",
    astWriter: "1.0",
    domain: `${def?.name ?? "default"}@${def?.version ?? "1.0"}`,
    catalog: CATALOG_REF,
  };
}

export function effectiveTables(snapshot: { tables: Array<{ table_name: string }> }, domain: string, modelChosen: string[]): string[] {
  const def = getDomainDefinition(domain);
  if (def && def.allowedEntities.length > 0) {
    return def.allowedEntities.map((t) => t.toUpperCase());
  }
  return modelChosen.length > 0 ? modelChosen : snapshot.tables.map((t) => t.table_name);
}

export function hasTemporalExpression(question: string): boolean {
  return /\b(last|past|next|this|previous|today|yesterday|tomorrow|week|month|year|days?|hours?)\b/i.test(question);
}
