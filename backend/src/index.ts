import dotenv from "dotenv";
dotenv.config();

import { serve } from "@hono/node-server";
import { app } from "./server";
import { flushTraces } from "./orchestration/observability";
import { validateEnv } from "./config/env-validation";

export { answerQuestion, type AnswerRequest, type AnswerResult } from "./orchestration/query-coordinator";
export { validateEnvelope, ProdEnvelopeSchema } from "./contracts/envelope-validator";
export type { ProdEnvelope } from "./contracts/query-envelope";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";

function start(): void {
  // P0-11: fail-fast on misconfiguration in production (warn-only in dev).
  validateEnv();
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
    flushTraces(3000)
      .catch(() => undefined)
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
