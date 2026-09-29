// Query AI AST v2 contract — strict Zod schemas for LLM-generated AST.
// JSON only; no SQL fragments; unknown keys rejected via .strict().
// Values (TypedValue) and identifiers (FieldRef) are never interchangeable.

import { z } from "zod";

export const AST_V2_VERSION = "2.0" as const;

export const EntityRefSchema = z
  .object({ entity: z.string().min(1), alias: z.string().min(1) })
  .strict();

export const FieldRefSchema = z
  .object({ kind: z.literal("field"), alias: z.string().min(1), field: z.string().min(1) })
  .strict();

export const ProjectionSchema = z
  .object({ field: FieldRefSchema, distinct: z.literal(true), output: z.literal("PARENT_UUID") })
  .strict();

export const JoinEqualitySchema = z
  .object({ left: FieldRefSchema, right: FieldRefSchema })
  .strict();

export const JoinSchema = z
  .object({
    type: z.enum(["INNER", "LEFT"]),
    entity: z.string().min(1),
    alias: z.string().min(1),
    on: z.array(JoinEqualitySchema).min(1),
  })
  .strict();

export const TypedValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), value: z.string() }).strict(),
  z.object({ type: z.literal("number"), value: z.number() }).strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("date"), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ type: z.literal("datetime"), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal("uuid"), value: z.string().uuid() }).strict(),
]);

export const AggregateExprSchema = z
  .object({
    kind: z.literal("aggregate"),
    function: z.enum(["COUNT", "COUNT_DISTINCT", "MIN", "MAX", "SUM", "AVG"]),
    field: FieldRefSchema.optional(),
  })
  .strict()
  .refine((v) => v.function === "COUNT" || v.field !== undefined, {
    message: "Only COUNT may omit field for COUNT(*); COUNT_DISTINCT/MIN/MAX/SUM/AVG require a field",
  });

export const OperandSchema = z.union([FieldRefSchema, AggregateExprSchema]);

const ComparisonPredicate = z
  .object({
    kind: z.literal("comparison"),
    left: OperandSchema,
    operator: z.enum(["EQ", "NE", "GT", "GTE", "LT", "LTE"]),
    right: TypedValueSchema,
  })
  .strict();

const TextPredicate = z
  .object({
    kind: z.literal("text"),
    field: FieldRefSchema,
    operator: z.enum(["CONTAINS", "STARTS_WITH", "ENDS_WITH"]),
    value: z.string().min(1),
    caseSensitive: z.boolean().optional(),
  })
  .strict();

const SetPredicate = z
  .object({
    kind: z.literal("set"),
    field: FieldRefSchema,
    operator: z.enum(["IN", "NOT_IN"]),
    values: z.array(TypedValueSchema).min(1).max(100),
  })
  .strict();

const NullPredicate = z
  .object({ kind: z.literal("null"), field: FieldRefSchema, operator: z.enum(["IS_NULL", "IS_NOT_NULL"]) })
  .strict();

const BetweenPredicate = z
  .object({
    kind: z.literal("between"),
    field: FieldRefSchema,
    lower: TypedValueSchema,
    upper: TypedValueSchema,
    lowerInclusive: z.boolean(),
    upperInclusive: z.boolean(),
  })
  .strict();

const RelativeDatePredicate = z
  .object({
    kind: z.literal("relativeDate"),
    field: FieldRefSchema,
    operator: z.enum(["IN_LAST", "IN_NEXT", "THIS", "PREVIOUS", "NEXT"]),
    amount: z.number().int().min(1).optional(),
    unit: z.enum(["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"]),
  })
  .strict();

export type Predicate = z.infer<typeof PredicateSchema>;
export const PredicateSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    ComparisonPredicate,
    TextPredicate,
    SetPredicate,
    NullPredicate,
    BetweenPredicate,
    RelativeDatePredicate,
    z.object({ kind: z.literal("boolean"), operator: z.enum(["AND", "OR"]), children: z.array(PredicateSchema).min(2).max(40) }).strict(),
    z.object({ kind: z.literal("not"), child: PredicateSchema }).strict(),
  ])
);

export const OrderItemSchema = z
  .object({ expression: OperandSchema, direction: z.enum(["ASC", "DESC"]), nulls: z.enum(["FIRST", "LAST"]).optional() })
  .strict();

export const QueryAstV2Schema = z
  .object({
    version: z.literal(AST_V2_VERSION),
    root: EntityRefSchema,
    projection: ProjectionSchema,
    joins: z.array(JoinSchema).max(4).optional(),
    where: PredicateSchema.optional(),
    groupBy: z.array(FieldRefSchema).max(8).optional(),
    having: PredicateSchema.optional(),
    orderBy: z.array(OrderItemSchema).max(4).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .refine((v) => (v.limit === undefined ? true : (v.orderBy?.length ?? 0) > 0), {
    message: "limit is allowed only with deterministic orderBy",
    path: ["limit"],
  });

export type QueryAstV2 = z.infer<typeof QueryAstV2Schema>;

export interface CatalogWhitelist {
  entities: Map<string, Set<string>>;
  aliases: Map<string, string>;
}

function collectFields(pred: unknown, out: Array<{ alias: string; field: string }>): void {
  if (!pred || typeof pred !== "object") return;
  const p = pred as Record<string, unknown>;
  for (const key of ["field", "left", "right", "child", "expression"]) {
    const v = p[key];
    if (v && typeof v === "object" && (v as Record<string, unknown>).kind === "field") {
      out.push({ alias: String((v as Record<string, unknown>).alias), field: String((v as Record<string, unknown>).field) });
    }
  }
  if (Array.isArray(p.children)) for (const c of p.children) collectFields(c, out);
  if (p.child) collectFields(p.child, out);
}

/** Strict whitelist check: every alias.field must exist in the catalog. Returns issue strings. */
export function validateAstCatalog(ast: QueryAstV2, catalog: CatalogWhitelist): string[] {
  const issues: string[] = [];
  const checkRef = (alias: string, field: string, path: string): void => {
    const entity = catalog.aliases.get(alias);
    if (!entity) {
      issues.push(`${path}: unknown alias "${alias}"`);
      return;
    }
    if (!catalog.entities.get(entity)?.has(field)) {
      issues.push(`${path}: unknown field "${entity}.${field}"`);
    }
  };
  checkRef(ast.projection.field.alias, ast.projection.field.field, "projection.field");
  if (ast.root.alias !== ast.projection.field.alias && ast.root.alias.length > 0) {
    if (!catalog.aliases.has(ast.root.alias)) issues.push(`root: unknown alias "${ast.root.alias}"`);
  }
  for (const [i, j] of (ast.joins ?? []).entries()) {
    if (!catalog.aliases.has(j.alias)) issues.push(`joins[${i}]: unknown alias "${j.alias}"`);
    for (const [k, eq] of j.on.entries()) {
      checkRef(eq.left.alias, eq.left.field, `joins[${i}].on[${k}].left`);
      checkRef(eq.right.alias, eq.right.field, `joins[${i}].on[${k}].right`);
    }
  }
  const refs: Array<{ alias: string; field: string }> = [];
  if (ast.where) collectFields(ast.where, refs);
  if (ast.having) collectFields(ast.having, refs);
  for (const g of ast.groupBy ?? []) checkRef(g.alias, g.field, "groupBy");
  for (const [i, o] of (ast.orderBy ?? []).entries()) {
    const e = o.expression as Record<string, unknown>;
    if (e.kind === "field") checkRef(String(e.alias), String(e.field), `orderBy[${i}]`);
    if (e.kind === "aggregate" && e.field) {
      const f = e.field as { alias: string; field: string };
      checkRef(f.alias, f.field, `orderBy[${i}].field`);
    }
  }
  refs.forEach((r, i) => checkRef(r.alias, r.field, `predicate[${i}]`));
  return issues;
}

function countNodes(pred: unknown, depth: number, state: { count: number; maxDepth: number }): void {
  if (!pred || typeof pred !== "object") return;
  state.count++;
  state.maxDepth = Math.max(state.maxDepth, depth);
  const p = pred as Record<string, unknown>;
  if (Array.isArray(p.children)) for (const c of p.children) countNodes(c, depth + 1, state);
  if (p.child) countNodes(p.child, depth + 1, state);
}

/** Deployment limits: 40 predicate nodes, boolean depth 6. Returns issue strings. */
export function validateAstLimits(ast: QueryAstV2): string[] {
  const issues: string[] = [];
  const state = { count: 0, maxDepth: 0 };
  if (ast.where) countNodes(ast.where, 1, state);
  if (ast.having) countNodes(ast.having, 1, state);
  if (state.count > 40) issues.push(`Too many predicate nodes (${state.count} > 40)`);
  if (state.maxDepth > 6) issues.push(`Boolean depth ${state.maxDepth} exceeds 6`);
  return issues;
}

/** Contract placement: aggregates legal only in having / aggregate ordering. Where must be aggregate-free. */
function containsAggregate(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.kind === "aggregate") return true;
  if (Array.isArray(n.children)) return (n.children as unknown[]).some(containsAggregate);
  if (n.child) return containsAggregate(n.child);
  if (n.left) return containsAggregate(n.left);
  if (n.expression) return containsAggregate(n.expression);
  return false;
}

export function validateAstAggregates(ast: QueryAstV2): string[] {
  const issues: string[] = [];
  if (ast.where && containsAggregate(ast.where)) {
    issues.push("where: aggregate operands are legal only in having / aggregate orderBy");
  }
  if (ast.having && containsAggregate(ast.having) && (ast.groupBy ?? []).length === 0) {
    issues.push("having: aggregate having requires non-empty groupBy");
  }
  return issues;
}

/**
 * Domain-aware projection lock.
 * - Single-uuid domains (e.g. all_test_sets -> TEST_SET_UUID): projection
 *   field MUST equal the domain column. This is the grid-filter contract.
 * - Flexible domains (e.g. default): any catalog field may project.
 * - Explicit requiredProjection.field (App Engine lock) wins over both.
 */
export function validateAstProjection(
  ast: QueryAstV2,
  opts: { domainColumn?: string; requiredField?: string } = {}
): string[] {
  const actual = ast.projection?.field?.field ?? "";
  const required = (opts.requiredField ?? "").trim();
  if (required) {
    if (actual.toUpperCase() !== required.toUpperCase()) {
      return [`projection: required field "${required}" but got "${actual}"`];
    }
    return [];
  }
  const column = (opts.domainColumn ?? "").trim();
  if (column) {
    if (actual.toUpperCase() !== column.toUpperCase()) {
      return [`projection: domain requires "${column}" but got "${actual}"`];
    }
  }
  return [];
}
