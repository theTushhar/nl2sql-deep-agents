import { z } from "zod";

// Minimal copy of backend/src/types/contracts.ts request shape.
// Kept local so NlQuery_InfoQAAI never imports backend singletons.
// P0-10: bound input sizes at the schema layer (400 via existing validator,
// same error shape — documented-bug fix, not a contract change).
const QUERY_MAX = 1500;
const ID_MAX = 128;
const DIALECT_MAX = 16;
export const QueryRequestSchema = z
  .object({
    query: z.string().max(QUERY_MAX).optional(),
    nl_query: z.string().max(QUERY_MAX).optional(),
    question: z.string().max(QUERY_MAX).optional(),
    domain: z.string().max(64).optional().default("default"),
    dialect: z.string().max(DIALECT_MAX).optional().default("mysql"),
    thread_id: z.string().max(ID_MAX).optional(),
    threadId: z.string().max(ID_MAX).optional(),
    request_id: z.string().max(ID_MAX).optional(),
    requestId: z.string().max(ID_MAX).optional(),
    include_traces: z.boolean().optional(),
    includeTraces: z.boolean().optional(),
    include_ast: z.boolean().optional(),
    includeAst: z.boolean().optional(),
    user_id: z.string().max(ID_MAX).optional(),
    userId: z.string().max(ID_MAX).optional(),
    context_filters: z.record(z.unknown()).optional(),
    contextFilters: z.record(z.unknown()).optional(),
    execute: z.boolean().optional(),
  })
  // Preserve caller-supplied fields (e.g. run_uuid, tenant_id, user_id,
  // test_set_uuid, context_filters) so they can be echoed back verbatim.
  // Unknown keys are capped by the same ID_MAX at echo time in server.ts.
  .passthrough();

export type QueryRequest = z.infer<typeof QueryRequestSchema>;

const isRealQuery = (v: unknown): v is string =>
  typeof v === "string" && v !== "string" && v.trim().length > 0;

export function getEffectiveQuery(req: QueryRequest): string | null {
  if (isRealQuery(req.query)) return req.query.trim();
  if (isRealQuery(req.nl_query)) return req.nl_query.trim();
  if (isRealQuery(req.question)) return req.question.trim();
  return null;
}

export function getEffectiveDialect(req: QueryRequest): string {
  const raw = typeof req.dialect === "string" ? req.dialect.trim().toLowerCase() : "";
  return raw || "mysql";
}

export function getEffectiveDomain(req: QueryRequest): string {
  const raw = typeof req.domain === "string" ? req.domain.trim().toLowerCase() : "";
  return raw || "default";
}

export function getEffectiveIncludeTraces(req: QueryRequest): boolean {
  return Boolean(req.include_traces || req.includeTraces);
}

/**
 * AST tool gate (v1-clean). Default true for backward compatibility:
 * omit the flag or pass true to receive `data.ast`; pass
 * `include_ast: false` (or `includeAst: false`) to skip the
 * buildAstTool call entirely and receive `ast: null`.
 */
export function getEffectiveIncludeAst(req: QueryRequest): boolean {
  if (req.include_ast === false || req.includeAst === false) return false;
  return true;
}
