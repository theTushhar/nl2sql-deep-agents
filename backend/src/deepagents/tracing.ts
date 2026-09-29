// Langfuse tracing for the deep-agents runtime (@langfuse/* v5 OTel stack).
// Docs-correct pattern (https://langfuse.com/docs/integrations/langchain):
// - OTel NodeSDK + LangfuseSpanProcessor started once at boot (see index.ts);
//   credentials come from the standard LANGFUSE_* env vars (see .env).
// - One root span "deep-agent-run" per /api/query request via startObservation.
// - CallbackHandler from @langfuse/langchain passed per agent.invoke():
//   every LLM call becomes a GENERATION, every `task` tool call becomes a
//   span named after the subagent (input-guard, sql-writer, ...), and every
//   snapshot-tool call becomes a nested tool span — automatically parented
//   under the active root span, no prompt or subagent changes needed.
// - Deterministic code gates (static certification, AST validation) get
//   manual nested spans via trace.runStep().
// Tags/session carry the dimensions the dashboard filters on
// (deep-agents, nl2sql, dialect, domain:<d>, req:<id>). Tracing never throws
// and is a complete no-op when LANGFUSE_ENABLED !== "true".
//
// NOTE: LangChain >=0.3 backgrounds callbacks by default, which would race
// the pre-response flush in server.ts and lose per-node spans. Blocking mode
// is enforced below (overridable via env) so spans complete before flush.

import { context, trace as otelTrace } from "@opentelemetry/api";
import { CallbackHandler } from "@langfuse/langchain";
import {
  getLangfuseTracerProvider,
  propagateAttributes,
  startActiveObservation,
  startObservation,
} from "@langfuse/tracing";
import type { LangfuseSpan } from "@langfuse/tracing";

if (process.env.LANGCHAIN_CALLBACKS_BACKGROUND === undefined) {
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";
}

/** Cap on serialized span I/O: full prompts stay out of the ingest path. */
const SPAN_IO_MAX_CHARS = 4096;

/**
 * Langfuse span hygiene (the trace was ~80% framework plumbing):
 * - Exact-name drops: `RunnableLambda` (LangChain internals), `__start__`
 *   (graph entry), `tools` (node wrapper duplicating each TOOL span),
 *   `model_request` (wrapper duplicating each ChatOpenAI generation).
 * - Suffix drops: `.*.before_model / .after_model / .before_agent /
 *   .after_agent` (per-call middleware hooks: ModelCallLimit, Skills,
 *   Filesystem, patchToolCalls).
 * Kept: the `deep-agent-run` root, `answer-question-deep`, every ChatOpenAI
 * GENERATION, every `task` TOOL + `<subagent>` span, snapshot TOOLs, and
 * `gate:*` code spans. Escape hatch: LANGFUSE_EXPORT_NOISY_SPANS=true.
 */
const NOISY_SPAN_NAMES = new Set([
  "RunnableLambda",
  "__start__",
  "tools",
  "model_request",
]);

const NOISY_SPAN_SUFFIXES = [
  ".before_model",
  ".after_model",
  ".before_agent",
  ".after_agent",
];

/** Export predicate for LangfuseSpanProcessor (side-effect-free). */
export function shouldExportTraceSpan(params: {
  otelSpan: { name?: string };
}): boolean {
  try {
    if (process.env.LANGFUSE_EXPORT_NOISY_SPANS === "true") return true;
    const name = params?.otelSpan?.name ?? "";
    if (NOISY_SPAN_NAMES.has(name)) return false;
    if (NOISY_SPAN_SUFFIXES.some((s) => name.endsWith(s))) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Truncate oversized span I/O before export: every generation repeats the
 * full system prompt + history, so a 9-generation trace carries ~10x dupes.
 * Only long strings are touched (ids and small attrs pass through); the
 * marker keeps it obvious in the Langfuse UI. Never throws.
 */
export function maskSpanData(params: { data: unknown }): unknown {
  try {
    const cap =
      Number(process.env.LANGFUSE_SPAN_IO_MAX_CHARS) || SPAN_IO_MAX_CHARS;
    const data = params?.data;
    if (typeof data !== "string" || data.length <= cap) return data;
    return `${data.slice(0, cap)}…[truncated ${data.length - cap} chars]`;
  } catch {
    return params?.data;
  }
}

export function isTracingEnabled(): boolean {
  return (
    process.env.LANGFUSE_ENABLED === "true" &&
    Boolean(
      process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
        process.env.LANGFUSE_SECRET_KEY?.trim()
    )
  );
}

export interface RequestTraceOptions {
  requestId?: string;
  threadId?: string;
  userId?: string;
  question: string;
  dialect: string;
  domain?: string;
}

export interface RequestTrace {
  /** Real Langfuse trace id. Falls back to caller request id when disabled. */
  traceId: string;
  /** Dashboard dimensions for this request (reused for invoke tags). */
  tags: string[];
  end(output: unknown, kind: string): void;
  /** Per-request handler (never shared: CallbackHandler is not concurrency-safe). */
  createCallback(): CallbackHandler | null;
  /** Run fn with the root span active so auto-traced spans nest under it. */
  runWithContext<T>(fn: () => Promise<T>): Promise<T>;
  /** Timed nested span for a deterministic code gate. */
  runStep<T>(
    name: string,
    input: unknown,
    fn: () => T | Promise<T>
  ): Promise<{ result: T; latencyMs: number }>;
}

function cleanStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** JSON-truncated snapshot for span I/O (never throws, never leaks objects). */
function trunc(value: unknown): unknown {
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > SPAN_IO_MAX_CHARS
      ? `${text.slice(0, SPAN_IO_MAX_CHARS)}…[truncated]`
      : JSON.parse(text);
  } catch {
    return String(value).slice(0, SPAN_IO_MAX_CHARS);
  }
}

export function startRequestTrace(opts: RequestTraceOptions): RequestTrace | null {
  if (!isTracingEnabled()) return null;
  try {
    const requestId = cleanStr(opts.requestId);
    const threadId = cleanStr(opts.threadId);
    const userId = cleanStr(opts.userId);
    const domain = cleanStr(opts.domain);
    const dialect = (opts.dialect || "mysql").toLowerCase();

    const tags = ["deep-agents", "nl2sql", dialect];
    if (domain) tags.push(`domain:${domain}`);
    if (requestId) tags.push(`req:${requestId}`);

    const root: LangfuseSpan = startObservation(
      "deep-agent-run",
      {
        input: trunc({ question: opts.question, dialect, domain }),
        metadata: {
          environment: process.env.NODE_ENV || "development",
          service: "infoqa-query-ai",
          ...(requestId ? { request_id: requestId } : {}),
          ...(threadId ? { thread_id: threadId } : {}),
          ...(domain ? { domain } : {}),
          dialect,
        },
      },
      { asType: "span" }
    );

    // Without a started OTel SDK the span is a non-recording proxy: bail to
    // the null-trace path so the envelope keeps the caller request id.
    if (!root.traceId || /^0+$/.test(root.traceId)) {
      console.warn("[tracing] OTel SDK not started; per-request spans disabled.");
      return null;
    }
    const traceId = root.traceId;

    const propagate = {
      ...(userId ? { userId } : {}),
      ...(threadId ? { sessionId: threadId } : {}),
      tags,
      traceName: "answer-question-deep",
      metadata: {
        ...(requestId ? { request_id: requestId } : {}),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(domain ? { domain } : {}),
        dialect,
      },
    };

    const runWithContext = <T>(fn: () => Promise<T>): Promise<T> =>
      propagateAttributes(propagate, () =>
        context.with(otelTrace.setSpan(context.active(), root.otelSpan), fn)
      );

    return {
      traceId,
      tags,
      end: (output: unknown, kind: string) => {
        try {
          root.update({
            output: trunc({ kind, traceId }),
            ...(kind === "error"
              ? { level: "ERROR" as const, statusMessage: `deep-agent-run ended: ${kind}` }
              : {}),
          });
          root.end();
        } catch {
          // Tracing must never crash execution
        }
      },
      createCallback: () => {
        try {
          return new CallbackHandler({
            ...(userId ? { userId } : {}),
            ...(threadId ? { sessionId: threadId } : {}),
            tags,
          });
        } catch (err) {
          console.warn("[tracing] Failed to create Langfuse callback handler:", err);
          return null;
        }
      },
      runWithContext,
      runStep: async <T>(
        name: string,
        input: unknown,
        fn: () => T | Promise<T>
      ): Promise<{ result: T; latencyMs: number }> => {
        const started = Date.now();
        const result = await runWithContext(() =>
          startActiveObservation(name, async (span) => {
            span.update({ input: trunc(input) });
            try {
              const out = await fn();
              span.update({ output: trunc(out) });
              return out;
            } catch (err) {
              span.update({
                level: "ERROR",
                statusMessage: `step failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 256),
              });
              throw err;
            }
          })
        );
        return { result, latencyMs: Date.now() - started };
      },
    };
  } catch (err) {
    console.warn("[tracing] Failed to start Langfuse trace:", err);
    return null;
  }
}

export async function flushTracing(timeoutMs = 5000): Promise<void> {
  if (!isTracingEnabled()) return;
  try {
    const provider = getLangfuseTracerProvider() as unknown as
      | { forceFlush?: () => Promise<void> }
      | null
      | undefined;
    if (typeof provider?.forceFlush !== "function") return;
    await Promise.race([
      provider.forceFlush(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("flush timeout")), timeoutMs)
      ),
    ]);
  } catch (err) {
    console.warn("[tracing] Failed to flush Langfuse traces:", err);
  }
}
