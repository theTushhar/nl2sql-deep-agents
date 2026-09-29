import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { validator } from "hono/validator";
import { randomUUID } from "crypto";
import { swaggerUI } from "@hono/swagger-ui";
import { openApiSpec } from "./api/openapi-spec";
import { answerQuestion } from "./agent/coordinator";
import { flushTracing as flushTraces } from "./agent/tracing";
import { DEFAULT_SNAPSHOT } from "./domain/config";
import { QueryRequestSchema, getEffectiveQuery, getEffectiveDialect, getEffectiveDomain, getEffectiveIncludeTraces, getEffectiveIncludeAst, getEffectiveRequiredProjection, getEffectiveTimeContext, RESPONSE_MAX_BYTES } from "./api/request-schema";
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

      const paramRequestId = c.req.query("request_id");
      const bodyRequestId = body.request_id;
      const requestId = paramRequestId || bodyRequestId || `req-${randomUUID()}`;

      const paramThreadId = c.req.query("thread_id");
      const bodyThreadId = body.thread_id;
      const threadId = paramThreadId || bodyThreadId || `thr-${randomUUID()}`;

      const domain = getEffectiveDomain(body);
      const dialect = getEffectiveDialect(body);
      const includeAst = getEffectiveIncludeAst(body);
      const userId = typeof body.user_id === "string" && body.user_id ? body.user_id : undefined;

      // Outer request guard: answerQuestion is internally bounded, but this
      // guarantees the socket always gets a response (504, never a hang)
      // even if a future pipeline step stalls outside that budget.
      const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 150000;
      const { envelope, kind } = await Promise.race([
        answerQuestion({
          requestId,
          threadId,
          userId,
          question,
          dialect,
          domain,
          includeAst,
          requiredProjection: getEffectiveRequiredProjection(body),
          timeContext: getEffectiveTimeContext(body),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Request timed out")), REQUEST_TIMEOUT_MS)
        ),
      ]);

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
      // Contract limit: response body 256KB (deployment config, not model value).
      if (JSON.stringify(payload).length > RESPONSE_MAX_BYTES) {
        return c.json({ status: "error", error: "Response exceeds 256KB limit" }, 500);
      }
      return c.json(payload, statusCode as 200 | 400 | 422 | 500);
    } catch (err) {
      // P0-9: generic 500 — never echo err.message (upstream LLM text) to client.
      // Timeout rejections are our own static strings (never LLM text), so a
      // 504 with a fixed message is safe and keeps the socket from hanging.
      if (err instanceof Error && err.message === "Request timed out") {
        return c.json({ status: "error", error: "Request timed out" }, 504);
      }
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
  // Skill pack names served natively by the deep agent (SkillsMiddleware);
  // bodies stay server-side under skills/<skill>/SKILL.md.
  return c.json({
    skills: [{ name: "default-reporting" }, { name: "all-test-sets" }],
  });
});

app.post("/api/v1/config/reload", (c) => {
  // Snapshot is file-v1 const for now; endpoint kept for backend API compat.
  return c.json({ status: "success", message: "Snapshot ref file-v1 active (static).", ref: DEFAULT_SNAPSHOT.ref });
});

export type AppType = typeof app;
