import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { validator } from "hono/validator";
import { randomUUID } from "crypto";
import { swaggerUI } from "@hono/swagger-ui";
import { openApiSpec } from "./api/openapi-spec";
import { answerQuestion } from "./orchestration/query-coordinator";
import { flushTraces } from "./orchestration/observability";
import { DEFAULT_SNAPSHOT } from "./config/domain-config";
import { QueryRequestSchema, getEffectiveQuery, getEffectiveDialect, getEffectiveDomain, getEffectiveIncludeTraces, getEffectiveIncludeAst } from "./api/query-request.schema";
import { toBackendEnvelope } from "./api/response-mapper";

export const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key", "x-api-key"],
  })
);

// No auth by design for now (minimal first). Add verifyApiKey later if needed.
// P0-10 residual: wildcard CORS + unauthenticated /api/query is a known risk;
// warn loudly in production without changing dev behavior.
if ((process.env.CORS_ORIGIN || "*") === "*" && process.env.NODE_ENV === "production") {
  console.warn("[security] CORS_ORIGIN=* in production: set an explicit allowlist.");
}

// P0-12: sanitized global error boundary + 404 (no internals leak).
app.onError((err, c) => {
  console.error("[server] unhandled error:", err instanceof Error ? err.message : String(err));
  return c.json({ status: "error", error: "Internal server error" }, 500);
});
app.notFound((c) => {
  return c.json({ status: "error", error: "Not found" }, 404);
});

// OpenAPI Documentation & Swagger UI
app.get("/openapi.json", (c) => c.json(openApiSpec));
app.get("/docs", swaggerUI({ url: "/openapi.json" }));
app.get("/swagger", swaggerUI({ url: "/openapi.json" }));

app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    service: "NlQuery_InfoQAAI-backend",
    version: "0.1.0",
    tables_registered: DEFAULT_SNAPSHOT.tables.length,
    domains_registered: DEFAULT_SNAPSHOT.domains.length,
    snapshot_ref: DEFAULT_SNAPSHOT.ref,
    timestamp: new Date().toISOString(),
  });
});

app.post(
  "/api/query",
  validator("json", (value, c) => {
    const parsed = QueryRequestSchema.safeParse(value);
    if (!parsed.success) {
      return c.json(
        { status: "error", error: "Invalid request payload", details: parsed.error.issues.map((i: { message: string }) => i.message).join("; ") },
        400
      );
    }
    if (!getEffectiveQuery(parsed.data)) {
      return c.json({ status: "error", error: "Field 'query' is required." }, 400);
    }
    return parsed.data;
  }),
  async (c) => {
    const startTime = Date.now();
    try {
      const body = c.req.valid("json");
      const question = getEffectiveQuery(body)!;

      const paramRequestId = c.req.query("request_id") || c.req.query("requestId");
      const bodyRequestId = body.request_id || body.requestId;
      const requestId = paramRequestId || bodyRequestId || `req-${randomUUID()}`;

      const paramThreadId = c.req.query("thread_id") || c.req.query("threadId");
      const bodyThreadId = body.thread_id || body.threadId;
      const threadId = paramThreadId || bodyThreadId || `thr-${randomUUID()}`;

      const domain = getEffectiveDomain(body);
      const dialect = getEffectiveDialect(body);

      // Echo caller fields verbatim (e.g. run_uuid, tenant_id, context_filters)
      // capped to ID_MAX-sized scalars to avoid unbounded reflection.
      const passthroughEcho: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (["nl_query", "query", "question"].includes(k)) continue;
        if (typeof v === "string" && v.length > 256) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
          passthroughEcho[k] = v;
        } else if (Array.isArray(v) && JSON.stringify(v).length <= 4096) {
          passthroughEcho[k] = v;
        } else if (typeof v === "object" && v !== null && JSON.stringify(v).length <= 4096) {
          passthroughEcho[k] = v;
        }
      }

      const includeAst = getEffectiveIncludeAst(body);

      const { envelope, kind } = await answerQuestion({
        echo: {
          ...passthroughEcho,
          requestId,
          threadId,
          domain,
          dialect,
        },
        question,
        dialect,
        domain,
        includeAst,
      });

      const includeTraces = getEffectiveIncludeTraces(body);

      const latencyMs = Date.now() - startTime;
      const { payload, statusCode } = toBackendEnvelope({
        envelope,
        kind,
        requestId,
        threadId,
        latencyMs,
        includeTraces,
      });
      // Await the flush BEFORE responding: fire-and-forget previously let
      // responses return before spans were exported, losing traces.
      await flushTraces().catch(() => undefined);
      return c.json(payload, statusCode as 200 | 400);
    } catch {
      // P0-9: generic 500 — never echo err.message (upstream LLM text) to client.
      return c.json({ status: "error", error: "Internal server error" }, 500);
    }
  }
);

const domainsHandler = (c: Context) => {
  return c.json({
    domains: DEFAULT_SNAPSHOT.domains.map((d: (typeof DEFAULT_SNAPSHOT.domains)[number]) => ({
      canonical_name: d.canonical_name,
      description: d.description,
      allowed_tables: d.allowedTables,
    })),
  });
};
app.get("/api/domains", domainsHandler);

app.get("/api/v1/schema", (c) => {
  return c.json({ tables: DEFAULT_SNAPSHOT.tables });
});

app.get("/api/v1/skills", (c) => {
  // Skill names mirror the loader convention; bodies stay server-side.
  return c.json({
    skills: [{ name: "query-writing" }, { name: "all-test-sets" }, { name: "query-critic" }],
  });
});

app.post("/api/v1/config/reload", (c) => {
  // Snapshot is file-v1 const for now; endpoint kept for backend API compat.
  return c.json({ status: "success", message: "Snapshot ref file-v1 active (static).", ref: DEFAULT_SNAPSHOT.ref });
});

export type AppType = typeof app;
