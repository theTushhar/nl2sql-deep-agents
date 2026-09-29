// Deep Agents coordinator: prompt-driven pipeline over createDeepAgent.
// The main agent delegates to isolated subagents via the task tool
// (input-guard -> query-normalizer (domain-agnostic) -> domain resolution
// (pinned request domain wins, router only for default/unpinned) ->
// domain-rephraser -> schema-explorer + business-rules -> sql-writer ->
// sql-critic, up to 3 rounds -> ast-generator on success when include_ast !== false).
// Deterministic guarantees stay in CODE (not prompts):
// - dialect allowlist gate
// - runStaticChecks fail-closed gate: uncertified SQL never leaves as success
// - strict AST validation (repair + v2 shape + catalog + SQL agreement)
// - composeResponse envelope assembly + validateEnvelope advisory check
// Tracing: one Langfuse trace per request (see tracing.ts).

import { randomUUID } from "crypto";
import { loadSnapshot } from "../config/domain-config";
import type { ProdEnvelope } from "../contracts/query-envelope";
import { composeResponse, type ComposerKind, type StageRecord } from "../orchestration/response-composer";
import { validateEnvelope } from "../contracts/envelope-validator";
import { runStaticChecks } from "../orchestration/sql-guardrails";
import { toDbNeutral, renderDialect } from "../orchestration/sql-ast";
import { getDeepAgent } from "./agent";
import { FinalAnswerSchema, type FinalAnswer } from "./schemas";
import { readModelName } from "./model";
import { startRequestTrace, flushTracing } from "./tracing";
import type { RequestTrace } from "./tracing";
import { createLlmRecorder, emptyLlm, type DrainedLlm } from "./llm-recorder";
import { validateAst, extractSqlTables, buildTimeContextText } from "./ast";
import type { AnswerRequest, AnswerResult } from "./types";

export { flushTracing };
export type { AnswerRequest, AnswerResult };
export type { TimeContext } from "./types";

/** Marker in unresolved[] when the AST tool fails but certified SQL stands. */
export const AST_FAILED_MARKER = "AST_VALIDATION_FAILED";

/**
 * Sanitized failure code for unresolved[]: the envelope `error` string is
 * intentionally NOT echoed to clients (it can carry upstream LLM/API text),
 * so error responses name the failure class with a static marker instead.
 */
function failureMarker(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out after/i.test(msg)) return "AGENT_FAILED (AGENT_TIMEOUT)";
  if (/model call limit/i.test(msg)) return "AGENT_FAILED (LLM_CALL_BUDGET_EXCEEDED)";
  if (/recursion/i.test(msg)) return "AGENT_FAILED (AGENT_RECURSION_LIMIT)";
  if (/final answer failed validation/i.test(msg)) return "AGENT_FAILED (FINAL_ANSWER_VALIDATION_FAILED)";
  if (/invalid schema|status.?400/i.test(msg)) return "AGENT_FAILED (LLM_SCHEMA_ERROR)";
  return "AGENT_FAILED (AGENT_INVOCATION_FAILED)";
}

const UNSUPPORTED_DIALECT_MESSAGE =
  "The requested query dialect is not supported. Please request the mysql dialect, and rephrase your question as a data question about your test sets, test cases, or test runs.";

// Bounded execution: the 9-stage delegation (plus writer/critic retries) is
// many sequential LLM round-trips. Without a cap a slow/upstream stall hangs
// the HTTP request forever. Env-overridable for slow models/proxies.
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 120000;
export const AGENT_RECURSION_LIMIT = Number(process.env.AGENT_RECURSION_LIMIT) || 80;

function effectiveTables(snapshot: ReturnType<typeof loadSnapshot>, domain: string, tables: string[]): string[] {
  const entry = snapshot.domains.find((d) => d.canonical_name.toLowerCase() === domain.toLowerCase());
  const allowed = entry?.allowedTables ?? [];
  if (allowed.length === 0) return tables;
  const ordered = [...allowed];
  for (const t of tables) {
    if (!ordered.includes(t)) ordered.push(t);
  }
  return ordered;
}

/**
 * Timed deterministic gate: always measures coordinator-side latency for the
 * envelope stages map; additionally records a nested Langfuse span when a
 * request trace is active. Never throws for tracing reasons.
 */
async function measureStep<T>(
  trace: RequestTrace | null,
  name: string,
  input: unknown,
  fn: () => T | Promise<T>
): Promise<{ result: T; latencyMs: number }> {
  const started = Date.now();
  const result = trace ? (await trace.runStep(name, input, fn)).result : await fn();
  return { result, latencyMs: Date.now() - started };
}

/** Empty stage record: latency is measured in code; per-generation tokens and cost live in Langfuse. */
function stageRecord(latencyMs: number): StageRecord {
  return { model: readModelName(), latencyMs, costUsd: 0, tokensIn: 0, tokensOut: 0 };
}

export async function answerQuestion(request: AnswerRequest): Promise<AnswerResult> {
  const started = Date.now();
  const echo = request.echo || {};
  const requestId =
    typeof echo.requestId === "string" && echo.requestId ? echo.requestId : randomUUID();
  const threadId =
    typeof echo.threadId === "string" && echo.threadId ? echo.threadId : `thr-${randomUUID()}`;
  const userId = typeof echo.user_id === "string" && echo.user_id ? echo.user_id : undefined;
  const issues: string[] = [];
  const snapshot = loadSnapshot(request.snapshotRef);
  const dialect = request.dialect.toLowerCase();
  const stages: Record<string, StageRecord> = {};
  const includeAst = request.includeAst !== false;

  const trace = startRequestTrace({
    requestId,
    threadId,
    userId,
    question: request.question,
    dialect,
    domain: request.domain,
  });
  // Prefer the Langfuse trace id; fall back to the caller request id when
  // tracing is disabled so telemetry.traceId is always populated.
  const traceId = trace?.traceId || requestId;

  // Per-request Langfuse callback (docs-correct auto-tracing): every LLM call
  // becomes a generation and every `task` subagent delegation a span, nested
  // under the trace root. Null when tracing is disabled — invoke runs untraced.
  const langfuseCallback = trace?.createCallback() ?? null;
  // Local per-call recorder: feeds include_traces + token telemetry on every
  // path (success AND error). Independent of Langfuse; always attached.
  const recorder = createLlmRecorder();
  let llm: DrainedLlm = emptyLlm();

  const finish = (kind: ComposerKind, envelope: ProdEnvelope): AnswerResult => {
    const envelopeIssues = validateEnvelope(envelope, kind);
    if (envelopeIssues.length > 0) {
      const summary = envelopeIssues.map((i) => `${i.path}: ${i.message}`).join("; ");
      console.warn(`[contract] envelope issues (${kind}): ${summary}`);
      issues.push(`Envelope validation: ${summary}`);
    }
    trace?.end({ kind, traceId }, kind);
    return { envelope, kind, traceId, issues };
  };

  if (!snapshot.supportedDialects.includes(dialect)) {
    const envelope = composeResponse({
      kind: "blocked",
      requestEcho: request.echo,
      dialect: request.dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: null,
      blockedMessage: UNSUPPORTED_DIALECT_MESSAGE,
      error: `Unsupported dialect: ${request.dialect}`,
      warnings: [],
      unresolved: [],
      filteringMetadata: null,
      domain: "default",
      intent: "blocked",
      complexity: "simple",
      tablesUsed: [],
      stages,
      triggers: [],
      retryCounts: {},
      traceId,
      latencyMs: Date.now() - started,
      configSnapshotRef: snapshot.ref,
      modelsLive: true,
    });
    return finish("blocked", envelope);
  }

  // 1. Delegate the whole workflow to the deep agent (prompt-driven).
  // Bounded: fresh checkpoint thread per request (a reused thread_id would
  // replay ever-growing MemorySaver history into every run), a recursion
  // cap on task-tool delegation loops, and a hard timeout so a stalled LLM
  // surfaces as kind=error instead of hanging the HTTP request.
  let final: FinalAnswer;
  try {
    const agent = await getDeepAgent();
    const checkpointThreadId = `${threadId}:${requestId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
    // setTimeout keeps the event loop alive; unref so idle processes can exit.
    timeout.unref?.();
    let result: unknown;
    try {
      const invokeInput = {
        messages: [
          {
            role: "user",
            content: [
              `NL question: ${request.question}`,
              `dialect: ${dialect}`,
              `domain hint: ${(request.domain || "default").toLowerCase()}`,
              `snapshot: ${snapshot.ref}`,
              `include_ast: ${includeAst}`,
              `time context: ${buildTimeContextText(request.timeContext)}`,
              `Run the coordinator workflow and return FinalAnswer JSON only.`,
            ].join("\n"),
          },
        ],
      };
      const invokeConfig = {
        configurable: { thread_id: checkpointThreadId },
        recursionLimit: AGENT_RECURSION_LIMIT,
        signal: controller.signal,
        // Langfuse auto-tracing (docs pattern): per-node generations + task
        // spans nest under the trace root via runWithContext below. Trace
        // attributes travel via runName/tags/metadata.
        runName: "answer-question-deep",
        tags: trace?.tags ?? ["deep-agents", "nl2sql"],
        metadata: {
          ...(userId ? { langfuseUserId: userId } : {}),
          langfuseSessionId: threadId,
        },
        ...(langfuseCallback ? { callbacks: [langfuseCallback, recorder] } : { callbacks: [recorder] }),
      } as Record<string, unknown>;
      const runInvoke = (): Promise<unknown> =>
        agent.invoke(invokeInput, invokeConfig) as Promise<unknown>;
      result = trace ? await trace.runWithContext(runInvoke) : await runInvoke();
    } catch (invokeErr) {
      if (controller.signal.aborted) {
        throw new Error(`Deep agent timed out after ${AGENT_TIMEOUT_MS}ms`);
      }
      throw invokeErr;
    } finally {
      clearTimeout(timeout);
    }
    // createDeepAgent with responseFormat returns structuredResponse alongside messages.
    const structured = (result as { structuredResponse?: unknown }).structuredResponse
      ?? (result as { response?: unknown }).response
      ?? null;
    const parsed = FinalAnswerSchema.safeParse(structured);
    if (!parsed.success) {
      throw new Error(`Deep agent final answer failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    final = parsed.data;
    // Total agent latency is measured in code. Per-call tokens come from the
    // local recorder (Langfuse generations have no local aggregation API),
    // so the stages map — and therefore telemetry + llmCallsCount — is real.
    llm = recorder.drain();
    stages["deep-agent"] = {
      ...stageRecord(Date.now() - started),
      tokensIn: llm.tokensIn,
      tokensOut: llm.tokensOut,
    };
  } catch (err) {
    // Calls that completed before the throw are still recorded: error
    // responses carry partial traces + tokens instead of zeros.
    llm = recorder.drain();
    stages["deep-agent"] = {
      ...stageRecord(Date.now() - started),
      tokensIn: llm.tokensIn,
      tokensOut: llm.tokensOut,
    };
    console.error(
      `[deep-agent] invocation failed: ${err instanceof Error ? err.message : String(err)}`
    );
    const envelope = composeResponse({
      kind: "error",
      requestEcho: request.echo,
      dialect: request.dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: null,
      blockedMessage: null,
      error: `Deep agent invocation failed: ${err instanceof Error ? err.message : String(err)}`,
      warnings: [],
      unresolved: [failureMarker(err)],
      filteringMetadata: null,
      domain: (request.domain || "default").toLowerCase(),
      intent: "error",
      complexity: "simple",
      tablesUsed: [],
      stages,
      triggers: [],
      retryCounts: {},
      traceId,
      latencyMs: Date.now() - started,
      configSnapshotRef: snapshot.ref,
      modelsLive: true,
      llmTraces: llm.llmTraces,
    });
    return finish("error", envelope);
  }

  const filteringMetadata =
    final.measures.length + final.filters.length + final.ordering.length + final.tablesUsed.length > 0
      ? {
          measures: final.measures,
          filters: final.filters,
          ordering: final.ordering,
          tables: final.tablesUsed,
          scope: final.searchScope.join(", "),
        }
      : null;

  // 2. Terminal non-success paths pass through (no SQL to certify).
  if (final.kind !== "success" || !final.sql) {
    const kind: ComposerKind = final.kind === "success" ? "error" : final.kind;
    const envelope = composeResponse({
      kind,
      requestEcho: request.echo,
      dialect: request.dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: final.conversationalResponse,
      blockedMessage: final.blockedMessage,
      error: final.error,
      warnings: final.warnings,
      unresolved: final.unresolved,
      filteringMetadata,
      domain: final.domain,
      intent: final.intent,
      complexity: final.complexity,
      tablesUsed: final.tablesUsed,
      stages,
      triggers: [],
      retryCounts: {},
      traceId,
      latencyMs: Date.now() - started,
      configSnapshotRef: snapshot.ref,
      modelsLive: true,
      llmTraces: llm.llmTraces,
    });
    return finish(kind, envelope);
  }

  // 3. Fail-closed static gate: uncertified SQL never leaves as success.
  // Narrow once: the guard above returned unless kind=success with SQL text.
  const candidateSql: string = final.sql;
  const allowed = effectiveTables(snapshot, final.domain, final.tablesUsed);
  const staticGate = await measureStep(
    trace,
    "gate:static-certification",
    { domain: final.domain, dialect: request.dialect, tables: final.tablesUsed },
    () =>
      runStaticChecks(candidateSql, allowed, [], snapshot, {
        dialect: request.dialect,
        domain: final.domain,
      })
  );
  const staticRes = staticGate.result;
  stages["gate:static-certification"] = stageRecord(staticGate.latencyMs);
  if (staticRes.errors.length > 0) {
    const envelope = composeResponse({
      kind: "error",
      requestEcho: request.echo,
      dialect: request.dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: null,
      blockedMessage: null,
      error: `SQL certification failed: ${staticRes.errors.slice(0, 3).join("; ")}`,
      warnings: [...final.warnings, ...staticRes.warnings],
      unresolved: final.unresolved,
      filteringMetadata,
      domain: final.domain,
      intent: final.intent,
      complexity: final.complexity,
      tablesUsed: final.tablesUsed,
      stages,
      triggers: [],
      retryCounts: {},
      traceId,
      latencyMs: Date.now() - started,
      configSnapshotRef: snapshot.ref,
      modelsLive: true,
      llmTraces: llm.llmTraces,
    });
    return finish("error", envelope);
  }

  // 4. Success: neutral + dialect render, then strict AST validation in code.
  const neutral = toDbNeutral(candidateSql);
  const rendered = renderDialect(neutral, request.dialect);
  let ast: unknown | null = null;
  const astUnresolved: string[] = [...final.unresolved];
  let rawAst: unknown = final.ast;
  if (typeof rawAst === "string") {
    try { rawAst = JSON.parse(rawAst); } catch (e) {}
  }

  if (!includeAst) {
    // include_ast=false: ast:null is contract-valid via the echoed opt-out.
  } else if (rawAst && typeof rawAst === "object" && !Array.isArray(rawAst)) {
    const raw = rawAst as Record<string, unknown>;
    if (raw.unsupported === true) {
      const code = typeof raw.reason_code === "string" ? raw.reason_code : "UNSUPPORTED_OPERATION";
      astUnresolved.push(`${AST_FAILED_MARKER} (${code})`);
    } else {
      const astGate = await measureStep(
        trace,
        "gate:ast-validation",
        { tables: final.tablesUsed },
        () => validateAst(raw, final.tablesUsed, snapshot, extractSqlTables(neutral))
      );
      const checked = astGate.result;
      stages["gate:ast-validation"] = stageRecord(astGate.latencyMs);
      if (checked.ast) {
        ast = checked.ast;
      } else {
        const detail = checked.errors.length > 0 ? `: ${checked.errors.slice(0, 3).join("; ")}` : "";
        astUnresolved.push(`${AST_FAILED_MARKER} (AST_VALIDATION_FAILED)${detail}`);
      }
    }
  } else {
    astUnresolved.push(`${AST_FAILED_MARKER} (AST_VALIDATION_FAILED: no AST JSON returned)`);
  }

  const envelope = composeResponse({
    kind: "success",
    requestEcho: request.echo,
    dialect: request.dialect.toLowerCase(),
    question: request.question,
    certifiedSql: rendered,
    dbNeutralQuery: neutral,
    ast,
    cert: null,
    conversationalResponse: null,
    blockedMessage: null,
    error: null,
    warnings: [...final.warnings, ...staticRes.warnings],
    unresolved: astUnresolved,
    filteringMetadata,
    domain: final.domain,
    intent: final.intent,
    complexity: final.complexity,
    tablesUsed: final.tablesUsed,
    stages,
    triggers: [],
    retryCounts: {},
    traceId,
    latencyMs: Date.now() - started,
    configSnapshotRef: snapshot.ref,
    modelsLive: true,
    llmTraces: llm.llmTraces,
  });
  return finish("success", envelope);
}
