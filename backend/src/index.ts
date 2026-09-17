import dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import { serve } from "@hono/node-server";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { app } from "./server";
import { resetDeepAgent } from "./agent/agent";
import { resetPromptCache } from "./agent/prompts";
import { flushTracing, isTracingEnabled, maskSpanData, shouldExportTraceSpan } from "./agent/tracing";
import { validateEnv } from "./domain/env-validation";

export { answerQuestion, type AnswerRequest, type AnswerResult } from "./agent/coordinator";
export { validateEnvelope, ProdEnvelopeSchema } from "./contracts/envelope-validator";
export type { ProdEnvelope } from "./contracts/query-envelope";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";

let otelSdk: NodeSDK | null = null;

/**
 * Start the OTel SDK once so @langfuse/langchain callback spans export to
 * Langfuse. Credentials come from the standard LANGFUSE_* env vars (.env).
 * No-op unless tracing is enabled; never throws.
 */
function startTelemetry(): void {
  if (!isTracingEnabled()) return;
  try {
    otelSdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl:
            process.env.LANGFUSE_BASE_URL ||
            process.env.LANGFUSE_HOST ||
            "https://cloud.langfuse.com",
          environment: process.env.NODE_ENV || "development",
          // Trace hygiene: drop framework-plumbing spans (RunnableLambda,
          // middleware before/after hooks, tools/model_request wrappers)
          // and truncate duped full-prompt generation payloads. See
          // tracing.ts; LANGFUSE_EXPORT_NOISY_SPANS=true disables filtering.
          shouldExportSpan: shouldExportTraceSpan,
          mask: maskSpanData,
        }),
      ],
    });
    otelSdk.start();
    console.log("[telemetry] Langfuse OTel tracing enabled.");
  } catch (err) {
    console.warn("[telemetry] Failed to start OTel SDK:", err);
    otelSdk = null;
  }
}

/**
 * Dev hot-reload for prompt tuning: `tsx watch` restarts on .ts changes but
 * ignores prompts/*.prompt.md. In non-production, watch that dir and drop
 * the memoized prompt bodies + deep-agent singleton on change, so the next
 * request picks up new wording with no restart. Never throws; no-op in
 * production (replicas reload via redeploy).
 */
function watchPromptsDev(): void {
  if ((process.env.NODE_ENV || "development") === "production") return;
  try {
    const dir = path.resolve(__dirname, "..", "prompts");
    let pending: NodeJS.Timeout | null = null;
    fs.watch(dir, (event, file) => {
      const name = String(file ?? "");
      if (!name.endsWith(".prompt.md") && name !== "_safety.md") return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        try {
          resetPromptCache();
          resetDeepAgent();
          console.log(`[prompts] reloaded ${event} ${name} — next request uses new wording.`);
        } catch (err) {
          console.warn("[prompts] hot-reload failed:", err instanceof Error ? err.message : String(err));
        }
      }, 250);
    });
    console.log("[prompts] watching prompts/ for hot-reload (dev only).");
  } catch {
    // Watch unavailable (e.g. packaged dist without prompts/) — restart to reload.
  }
}

/** Bounded SDK shutdown (flushes pending spans, never hangs shutdown). */
async function stopTelemetry(timeoutMs = 3000): Promise<void> {
  if (!otelSdk) return;
  try {
    await Promise.race([
      otelSdk.shutdown(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("otel shutdown timeout")), timeoutMs)
      ),
    ]);
  } catch (err) {
    console.warn("[telemetry] OTel shutdown issue:", err);
  } finally {
    otelSdk = null;
  }
}

function start(): void {
  // P0-11: fail-fast on misconfiguration in production (warn-only in dev).
  validateEnv();
  startTelemetry();
  watchPromptsDev();
  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`[*] NlQuery_InfoQAAI running at http://${info.address}:${info.port}`);
    console.log(`[*] Health:   GET  http://localhost:${info.port}/health`);
    console.log(`[*] Query:    POST http://localhost:${info.port}/api/query`);
  });

  // P1-1: flush pending Langfuse traces on shutdown with a bounded wait,
  // then force-exit so a hanging keep-alive can't stall K8s SIGTERM.
  const shutdown = (signal: string) => {
    console.log(`[*] Received ${signal}, shutting down...`);
    let exited = false;
    const force = setTimeout(() => {
      if (!exited) {
        console.warn("[*] Shutdown timed out, forcing exit.");
        process.exit(0);
      }
    }, 8000);
    force.unref?.();
    flushTracing(3000)
      .catch(() => undefined)
      .then(() => stopTelemetry(3000))
      .then(() => {
        server.close(() => {
          exited = true;
          console.log("[*] Server closed cleanly.");
          process.exit(0);
        });
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // P1-1: never die silently — log and keep serving on unexpected rejections.
  process.on("unhandledRejection", (reason) => {
    console.error("[*] unhandledRejection:", reason instanceof Error ? reason.message : String(reason));
  });
  process.on("uncaughtException", (err) => {
    console.error("[*] uncaughtException:", err instanceof Error ? err.message : String(err));
  });
}

export async function main(): Promise<void> {
  start();
}

// Only auto-start when executed directly (node dist/index.js), not on import.
if (require.main === module) {
  start();
}
