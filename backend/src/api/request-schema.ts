import { z } from "zod";

export const QUERY_MAX = 500;
export const RESPONSE_MAX_BYTES = 256 * 1024;
const ID_MAX = 128;
const DIALECT_MAX = 16;

export const QueryRequestSchema = z
  .object({
    query: z.string().max(QUERY_MAX).optional(),
    domain: z.string().max(64).optional().default("default"),
    dialect: z.string().max(DIALECT_MAX).optional().default("mysql"),
    thread_id: z.string().max(ID_MAX).optional(),
    request_id: z.string().max(ID_MAX).optional(),
    include_traces: z.boolean().optional(),
    include_ast: z.boolean().optional().default(true),
    include_sql: z.boolean().optional().default(true),
    user_id: z.string().max(ID_MAX).optional(),
    context_filters: z.record(z.string(), z.unknown()).optional(),
    execute: z.boolean().optional(),
    ast_version: z.string().max(DIALECT_MAX).optional(),
    required_projection: z
      .object({ field: z.string().max(64).optional(), output: z.string().max(32).optional(), distinct: z.boolean().optional() })
      .passthrough()
      .optional(),
    time_context: z
      .object({ time_zone: z.string().max(64).optional(), now: z.string().max(64).optional(), week_starts_on: z.string().max(16).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type QueryRequest = z.infer<typeof QueryRequestSchema>;

const isRealQuery = (v: unknown): v is string =>
  typeof v === "string" && v !== "string" && v.trim().length > 0;

export function getEffectiveQuery(req: QueryRequest): string | null {
  if (isRealQuery(req.query)) return req.query.trim();
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
  return Boolean(req.include_traces);
}

export function getEffectiveIncludeAst(req: QueryRequest): boolean {
  return req.include_ast !== false;
}

export function getEffectiveIncludeSql(req: QueryRequest): boolean {
  return req.include_sql !== false;
}

export function isDualOutputDisabled(req: QueryRequest): boolean {
  return getEffectiveIncludeAst(req) === false && getEffectiveIncludeSql(req) === false;
}

export function getEffectiveRequiredProjection(req: QueryRequest): { field?: string; output?: string; distinct?: boolean } | undefined {
  const raw = req.required_projection;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as { field?: string; output?: string; distinct?: boolean };
}

export function getEffectiveTimeContext(req: QueryRequest): { time_zone?: string; now?: string; week_starts_on?: string } | undefined {
  const raw = req.time_context;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as { time_zone?: string; now?: string; week_starts_on?: string };
}
