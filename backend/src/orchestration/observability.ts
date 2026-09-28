import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { Langfuse } from "langfuse";

export interface TraceConfig {
  fullTraces: boolean;
  backend: "langfuse";
}

let client: Langfuse | null = null;

/** Async context carried through the whole request pipeline. */
interface TraceStore {
  trace: any | null;
  recordKey: string;
}

const traceStorage = new AsyncLocalStorage<TraceStore>();

export function isLangfuseEnabled(): boolean {
  return (
    process.env.LANGFUSE_ENABLED === "true" &&
    Boolean(
      process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
      process.env.LANGFUSE_SECRET_KEY?.trim()
    )
  );
}

export function getLangfuse(): Langfuse | null {
  if (!isLangfuseEnabled()) return null;
  if (!client) {
    const baseUrl =
      process.env.LANGFUSE_BASE_URL ||
      process.env.LANGFUSE_HOST ||
      "https://cloud.langfuse.com";
    client = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl,
    });
  }
  return client;
}

export function getActiveTrace(): any | null {
  return traceStorage.getStore()?.trace || null;
}

function getRecordKey(): string | null {
  return traceStorage.getStore()?.recordKey || null;
}

/**
 * Run `fn` inside the request trace context. ALL pipeline work for one
 * /api/query turn must execute inside this scope so child generations
 * attach to the parent trace instead of becoming orphan root traces.
 */
export function runInTraceContext<T>(handle: TraceHandle | null, recordKey: string, fn: () => T): T {
  return traceStorage.run({ trace: handle?.__raw ?? null, recordKey }, fn);
}

export interface TraceHandle {
  /** Langfuse trace id (real UUID — never a caller request id). */
  traceId: string;
  /** Key for the in-memory per-request LLM record buffer. */
  recordKey: string;
  /** Raw Langfuse trace object for child observations. Internal. */
  __raw: any | null;
  update: (data: Record<string, unknown>) => void;
  end: () => void;
}

export interface StartTraceOptions {
  requestId?: string;
  threadId?: string;
  userId?: string;
  domain?: string;
  dialect?: string;
}

function cleanStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function startTrace(name: string, opts: StartTraceOptions = {}): TraceHandle | null {
  // Record key is always issued so per-request LLM records work even when
  // Langfuse is disabled (they feed the API `llmTraces` response field).
  const recordKey = randomUUID();
  const lf = getLangfuse();
  if (!lf) return null;

  try {
    // NOTE: the Langfuse trace id must be a UUID. Caller request ids
    // (e.g. "req-...") are NOT valid and get rejected by the API, which
    // previously caused the parent trace to vanish while generations
    // survived as scattered single-generation traces.
    const traceId = randomUUID();
    const requestId = cleanStr(opts.requestId);
    const threadId = cleanStr(opts.threadId);
    const userId = cleanStr(opts.userId);
    const domain = cleanStr(opts.domain);
    const dialect = cleanStr(opts.dialect) || "mysql";

    const tags = ["deep-agents", "nl2sql", dialect];
    if (domain) tags.push(`domain:${domain}`);
    if (requestId) tags.push(`req:${requestId}`);

    const trace = lf.trace({
      id: traceId,
      name,
      input: { requestId, threadId, domain, dialect },
      ...(threadId ? { sessionId: threadId } : {}),
      ...(userId ? { userId } : {}),
      tags,
      metadata: {
        environment: process.env.NODE_ENV || "development",
        service: "deep-agent-ecosystem",
        ...(requestId ? { request_id: requestId } : {}),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(domain ? { domain } : {}),
        dialect,
      },
    });

    // NOTE: no enterWith here — the coordinator wraps the pipeline in
    // runInTraceContext so context propagates across awaits + Promise.all.

    return {
      traceId: trace.id,
      recordKey,
      __raw: trace,
      update: (data: Record<string, unknown>) => {
        try {
          trace.update(data as any);
        } catch {
          // Tracing must never crash execution
        }
      },
      end: () => {
        // Langfuse trace ends on flush
      },
    };
  } catch (err) {
    console.warn("[tracing] Failed to start Langfuse trace:", err);
    return null;
  }
}

export function endTrace(handle: TraceHandle | null, output: unknown): void {
  if (!handle) return;
  try {
    handle.update({ output });
    handle.end();
  } catch {
    // Tracing must never crash execution
  }
}

// ---------------------------------------------------------------------------
// In-memory per-request LLM call records. These feed the API `llmTraces`
// response field and are recorded regardless of Langfuse enablement.
// ---------------------------------------------------------------------------

export interface LlmCallRecord {
  /** Low-cardinality stage name (e.g. "generate-sql"). */
  name: string;
  model: string;
  prompt: string;
  response: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  live: boolean;
}

const MAX_RECORDS_PER_KEY = 64;
const MAX_BUFFER_KEYS = 100;

const recordBuffer = new Map<string, LlmCallRecord[]>();
const overflowRecords: LlmCallRecord[] = [];

function pushRecord(key: string | null, record: LlmCallRecord): void {
  if (!key) {
    overflowRecords.push(record);
    if (overflowRecords.length > MAX_RECORDS_PER_KEY) overflowRecords.shift();
    return;
  }
  let list = recordBuffer.get(key);
  if (!list) {
    if (recordBuffer.size >= MAX_BUFFER_KEYS) {
      const oldest = recordBuffer.keys().next().value;
      if (oldest) recordBuffer.delete(oldest);
    }
    list = [];
    recordBuffer.set(key, list);
  }
  if (list.length < MAX_RECORDS_PER_KEY) list.push(record);
}

/** Drain and return the records for one request. Always call at request end. */
export function takeTraceRecords(recordKey: string): LlmCallRecord[] {
  const list = recordBuffer.get(recordKey) || [];
  recordBuffer.delete(recordKey);
  return list;
}

export function formatPrompt(messages: Array<{ role: string; content: string }>): string {
  return messages.map((m) => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n");
}

export interface GenerationHandle {
  update: (data: Record<string, unknown>) => void;
  end: () => void;
}

interface PendingGeneration extends GenerationHandle {
  __pending?: {
    recordKey: string | null;
    name: string;
    model: string;
    prompt: string;
    startTime: number;
  };
}

export function startGeneration(
  name: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  temperature: number
): GenerationHandle | null {
  const recordKey = getRecordKey();
  const pending = {
    recordKey,
    name,
    model,
    prompt: formatPrompt(messages),
    startTime: Date.now(),
  };

  const lf = getLangfuse();
  if (!lf) {
    // Langfuse off: still return a handle so the record is captured below.
    return createLocalGenerationHandle(pending);
  }

  try {
    const parentTrace = getActiveTrace();
    const generationParams: any = {
      name,
      model,
      input: messages,
      modelParameters: { temperature },
      startTime: new Date(),
    };

    const generation = parentTrace
      ? parentTrace.generation(generationParams)
      : lf.generation(generationParams);

    const handle: PendingGeneration = {
      update: (data: Record<string, unknown>) => {
        try {
          generation.update(data as any);
        } catch {
          // Tracing must never crash execution
        }
      },
      end: () => {
        try {
          generation.end();
        } catch {
          // Tracing must never crash execution
        }
      },
    };
    handle.__pending = pending;
    return handle;
  } catch (err) {
    console.warn("[tracing] Failed to start Langfuse generation:", err);
    return createLocalGenerationHandle(pending);
  }
}

function createLocalGenerationHandle(
  pending: PendingGeneration["__pending"] & {}
): GenerationHandle {
  const handle: PendingGeneration = { update: () => {}, end: () => {} };
  handle.__pending = pending;
  return handle;
}

export function endGeneration(
  generation: GenerationHandle | null,
  output: string,
  promptTokens: number,
  completionTokens: number,
  error: unknown,
  model?: string,
  live?: boolean
): void {
  const pending = (generation as PendingGeneration | null)?.__pending;
  if (pending) {
    pushRecord(pending.recordKey, {
      name: pending.name,
      model: model || pending.model,
      prompt: pending.prompt,
      response: output,
      latencyMs: Date.now() - pending.startTime,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      live: live ?? !error,
    });
  }
  if (!generation || typeof generation.update !== "function") return;
  try {
    if (error) {
      generation.update({
        output: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
        level: "ERROR",
        statusMessage: error instanceof Error ? error.message : String(error),
      });
    } else {
      // v3 SDK usage shape is { input, output, total } — the old
      // { promptTokens, completionTokens } keys were silently dropped,
      // which is why generations showed no tokens/cost in the dashboard.
      generation.update({
        ...(model ? { model } : {}),
        output,
        usage: {
          input: promptTokens,
          output: completionTokens,
          total: promptTokens + completionTokens,
        },
      });
    }
    generation.end();
  } catch {
    // Tracing must never crash execution
  }
}

export async function flushTraces(timeoutMs = 5000): Promise<void> {
  const lf = getLangfuse();
  if (!lf) return;
  try {
    await Promise.race([
      lf.flushAsync(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("flush timeout")), timeoutMs)
      ),
    ]);
  } catch (err) {
    console.warn("[tracing] Failed to flush Langfuse traces:", err);
  }
}
