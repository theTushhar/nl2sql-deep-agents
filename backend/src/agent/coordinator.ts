// Deep Agents coordinator: prompt-driven pipeline over createDeepAgent.
// The main agent delegates to isolated subagents via the task tool
// (planner -> writer, exactly once each). The planner normalizes the
// question and plans tables/search/rules via tools; the writer emits ONE
// SELECT plus its AST v2 JSON in a single response. There is no LLM checker:
// safety is enforced deterministically in CODE (not prompts):
// - dialect allowlist gate
// - runStaticChecks fail-closed gate: uncertified SQL never leaves as success
// - plan gates: deterministic complexity, rule coverage, table agreement,
//   undeclared-filter rejection (writer must not invent status filters)
// - strict AST validation (repair + v2 shape + catalog + SQL agreement)
// - composeResponse envelope assembly + validateEnvelope advisory check
// Tracing: one Langfuse trace per request (see tracing.ts).

import { loadSnapshot } from "../domain/config";
import type { ProdEnvelope } from "../contracts/query-envelope";
import { composeResponse, type ComposerKind, type StageRecord } from "../domain/response-composer";
import { validateEnvelope } from "../contracts/envelope-validator";
import { runStaticChecks } from "../domain/guardrails";
import { toDbNeutral, renderDialect, sqlToAstV2 } from "../domain/sql-ast";
import { getDeepAgent } from "./agent";
import { FinalAnswerSchema, type FinalAnswer } from "./schemas";
import { readModelName } from "./model";
import { startRequestTrace, flushTracing } from "./tracing";
import type { RequestTrace } from "./tracing";
import { createLlmRecorder, emptyLlm, type DrainedLlm } from "./recorder";
import { validateAst, extractSqlTables, buildTimeContextText } from "../domain/ast-validator";
import {
  calculateComplexity,
  findMissingRuleClauses,
  findTableDrift,
  hasUndeclaredStatusFilter,
} from "../domain/query-plan";
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
 * The constructor name suffix (alphanumeric only, no message text) tells
 * operators which layer threw without leaking anything.
 */
function failureMarker(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cls =
    err instanceof Error
      ? String(err.constructor?.name ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "Error"
      : "Error";
  if (/timed out after/i.test(msg)) return "AGENT_FAILED (AGENT_TIMEOUT)";
  if (/model call limit/i.test(msg)) return "AGENT_FAILED (LLM_CALL_BUDGET_EXCEEDED)";
  if (/recursion/i.test(msg)) return "AGENT_FAILED (AGENT_RECURSION_LIMIT)";
  if (/final answer failed validation/i.test(msg)) return "AGENT_FAILED (FINAL_ANSWER_VALIDATION_FAILED)";
  if (/invalid schema|status.?400/i.test(msg)) return "AGENT_FAILED (LLM_SCHEMA_ERROR)";
  return `AGENT_FAILED (AGENT_INVOCATION_FAILED:${cls})`;
}

const UNSUPPORTED_DIALECT_MESSAGE =
  "The requested query dialect is not supported. Please request the mysql dialect, and rephrase your question as a data question about your test sets, test cases, or test runs.";

// Bounded execution: the 3-stage delegation (plus one writer retry) is a few
// sequential LLM round-trips. Without a cap a slow/upstream stall hangs
// the HTTP request forever. Env-overridable for slow models/proxies.
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 120000;
export const AGENT_RECURSION_LIMIT = Number(process.env.AGENT_RECURSION_LIMIT) || 80;

/**
 * Strict domain table gate: a domain with a non-empty allow-list permits
 * ONLY those tables. Model-chosen tables are never merged in — otherwise the
 * static gate would certify whatever the model lists (fail-open). A domain
 * with an empty allow-list ("default") permits any snapshot table; unknown
 * tables still fail inside runStaticChecks. Non-allowed tables in the SQL
 * surface as "Hallucinated table" errors → kind=error (strict reject).
 */
function effectiveTables(snapshot: ReturnType<typeof loadSnapshot>, domain: string, tables: string[]): string[] {
  const entry = snapshot.domains.find((d) => d.canonical_name.toLowerCase() === domain.toLowerCase());
  const allowed = entry?.allowedTables ?? [];
  if (allowed.length === 0) return tables;
  return [...allowed];
}

/**
 * P0-3: conditional time context. Returns true when the NL question carries
 * a temporal expression (relative-date keyword, 4-digit year, or ISO date),
 * in which case invokeInput injects the resolved time context; otherwise the
 * coordinator sends `time context: none` so the planner skips temporal
 * filters without an LLM round-trip. Exported for offline verification.
 */
export function hasTemporalExpression(question: string): boolean {
  if (!question) return false;
  if (
    /\b(today|yesterday|tomorrow|last\s+\w+|past\s+\d+|this\s+(week|month|quarter|year)|recent|ago|since|between|after|before|now|current|latest)\b/i.test(
      question
    )
  ) {
    return true;
  }
  if (/\b(19|20)\d{2}\b/.test(question)) return true;
  if (/\d{4}-\d{2}-\d{2}/.test(question)) return true;
  return false;
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

/**
 * Text content of one result message, defensively across serialized shapes
 * (BaseMessage instances, plain `{content}`, or `{kwargs: {content}}`).
 */
function messageTextOf(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";
  const rec = msg as Record<string, unknown>;
  const content = rec.content ?? (rec.kwargs as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string"
          ? b
          : typeof b === "object" && b !== null && "text" in b
            ? String((b as { text: unknown }).text)
            : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Tool-call args across message shapes (AIMessage `tool_calls`, `function_call`, serialized `kwargs`). */
function toolCallArgsOf(msg: unknown): unknown[] {
  if (!msg || typeof msg !== "object") return [];
  const rec = msg as Record<string, unknown>;
  const out: unknown[] = [];
  const calls = rec.tool_calls ?? (rec.kwargs as Record<string, unknown> | undefined)?.tool_calls;
  if (Array.isArray(calls)) {
    for (const c of calls) {
      const args = (c as Record<string, unknown>)?.args ?? (c as Record<string, unknown>)?.function?.["arguments" as never];
      if (args !== undefined) out.push(args);
    }
  }
  const fn = (rec.function_call ?? (rec.kwargs as Record<string, unknown> | undefined)?.function_call) as
    | { arguments?: unknown }
    | undefined;
  if (fn?.arguments !== undefined) out.push(fn.arguments);
  const additional = rec.additional_kwargs as Record<string, unknown> | undefined;
  const afn = additional?.function_call as { arguments?: unknown } | undefined;
  if (afn?.arguments !== undefined) out.push(afn.arguments);
  return out;
}

/** Parse a candidate value (object, JSON string, or ```json fenced JSON) into an object. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  const candidates = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace?.[0] && brace[0] !== text) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Normalize a candidate FinalAnswer object before schema validation.
 * Models routinely omit null-valued keys (undefined instead of null) and
 * empty arrays; the schema requires them. Fill only what has an unambiguous
 * empty value — kind/domain/intent/complexity stay required. Exported for
 * offline verification.
 */
export function normalizeFinalAnswer(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of ["sql", "ast", "conversationalResponse", "blockedMessage", "error"]) {
    if (out[k] === undefined) out[k] = null;
  }
  for (const k of [
    "tablesUsed",
    "appliedRuleIds",
    "measures",
    "filters",
    "ordering",
    "searchScope",
    "warnings",
    "unresolved",
  ]) {
    if (out[k] === undefined) out[k] = [];
  }
  return out;
}

/**
 * Fallback FinalAnswer extraction when the runtime returns no
 * `structuredResponse` (model emitted JSON as text, or called the
 * literally-named FinalAnswer echo tool, instead of calling the
 * FinalAnswer synthetic tool, e.g. after budget pressure or a skipped tool
 * call). Scans tool-call args first, then message text newest-first.
 * Exported for offline verification; the coordinator uses it internally.
 */
export function extractFinalAnswerFallback(result: unknown): unknown | null {
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    for (const args of toolCallArgsOf(messages[i])) {
      const obj = asObject(args);
      if (obj && typeof obj.kind === "string") return obj;
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const obj = asObject(messageTextOf(messages[i]));
    if (obj && typeof obj.kind === "string") return obj;
  }
  return null;
}

export async function answerQuestion(request: AnswerRequest): Promise<AnswerResult> {
  const started = Date.now();
  const requestId = request.requestId;
  const threadId = request.threadId;
  const userId = request.userId;
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
    // The validator needs the caller's include_ast opt-out explicitly: the
    // envelope carries no caller metadata by contract.
    const envelopeIssues = validateEnvelope(envelope, kind, { includeAst });
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
              `candidateTables: ${(() => {
                const domainLower = (request.domain || "default").toLowerCase();
                const resolved = effectiveTables(snapshot, domainLower, []);
                const tables = resolved.length > 0 ? resolved : snapshot.tables.map((t) => t.table_name);
                return tables.join(", ") || "(none)";
              })()}`,
              `snapshot: ${snapshot.ref} (config ID, not a file path — never read it as a file)`,
              `include_ast: ${includeAst}`,
              `include_sql: ${request.includeSql !== false}`,
              hasTemporalExpression(request.question)
                ? `time context: ${buildTimeContextText(request.timeContext)}`
                : `time context: none (no temporal filter)`,
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
      // One retry on a fresh checkpoint thread, ONLY for retryable
      // graph-state corruption (e.g. parallel tool calls poisoning the
      // thread: InvalidUpdateError). Resuming a poisoned thread would fail
      // again, so restart cleanly instead. Budget exhaustion
      // (ModelCallLimit), timeouts, and model errors are NOT retried: the
      // retry would replay the same delegation loop and burn another full
      // timeout window for nothing.
      const retryableGraphError = (e: unknown): boolean => {
        if (controller.signal.aborted) return false;
        const name = e instanceof Error ? (e.name ?? "") : "";
        const msg = e instanceof Error ? e.message : String(e);
        return /invalidupdateerror|invalid update|parallel/i.test(`${name} ${msg}`);
      };
      try {
        result = trace ? await trace.runWithContext(runInvoke) : await runInvoke();
      } catch (firstErr) {
        if (!retryableGraphError(firstErr)) throw firstErr;
        console.warn(
          `[deep-agent] invoke hit retryable graph-state error, retrying once on a fresh thread: ${firstErr instanceof Error ? firstErr.constructor.name : String(firstErr)}`
        );
        (invokeConfig.configurable as Record<string, unknown>).thread_id = `${checkpointThreadId}:r1`;
        result = trace ? await trace.runWithContext(runInvoke) : await runInvoke();
      }
    } catch (invokeErr) {
      if (controller.signal.aborted) {
        throw new Error(`Deep agent timed out after ${AGENT_TIMEOUT_MS}ms`);
      }
      throw invokeErr;
    } finally {
      clearTimeout(timeout);
    }
    // createDeepAgent with responseFormat returns structuredResponse alongside messages.
    // Fallback: when the model answers in text instead of calling the
    // FinalAnswer synthetic tool (observed as structuredResponse=null after
    // long runs), recover the JSON from tool-call args / message text
    // newest-first instead of failing the whole request.
    let structured: unknown =
      (result as { structuredResponse?: unknown }).structuredResponse
      ?? (result as { response?: unknown }).response
      ?? null;
    let recoveredFromText = false;
    if (structured === null) {
      const fallback = extractFinalAnswerFallback(result);
      if (fallback !== null) {
        structured = fallback;
        recoveredFromText = true;
      }
    }
    // Boundary hardening: the writer returns its AST as an object and the
    // coordinator must stringify it into FinalAnswer.ast (string|null), but
    // if the model passes the object through raw, coerce instead of failing
    // the whole request — downstream already accepts both shapes.
    if (
      structured !== null &&
      typeof structured === "object" &&
      !Array.isArray(structured) &&
      (structured as Record<string, unknown>).ast !== null &&
      typeof (structured as Record<string, unknown>).ast === "object"
    ) {
      try {
        (structured as Record<string, unknown>).ast = JSON.stringify(
          (structured as Record<string, unknown>).ast
        );
      } catch {
        (structured as Record<string, unknown>).ast = null;
      }
    }
    const parsed = FinalAnswerSchema.safeParse(normalizeFinalAnswer(structured));
    if (!parsed.success) {
      const messageCount = Array.isArray((result as { messages?: unknown }).messages)
        ? ((result as { messages?: unknown[] }).messages as unknown[]).length
        : 0;
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new Error(
        `Deep agent final answer failed validation` +
        `${structured === null ? " (no structured tool call; " : " ("}` +
        `${structured === null ? `messages=${messageCount}` : `recoveredFromText=${recoveredFromText}`}` +
        `): ${detail}`
      );
    }
    final = parsed.data;
    // Domain hardening: the coordinator prompt requires a real snapshot
    // domain, but a vague task description can make the planner echo back
    // the subagent name (observed: domain="planner"). Fall back to the
    // caller's pinned hint instead of leaking a non-domain through to
    // meta.domain and the static gate.
    {
      const known = new Set(snapshot.domains.map((d) => d.canonical_name.toLowerCase()));
      if (!known.has((final.domain || "").toLowerCase())) {
        const fallback = (request.domain || "default").toLowerCase();
        console.warn(`[deep-agent] unknown FinalAnswer domain '${final.domain}', falling back to '${fallback}'`);
        final = { ...final, domain: known.has(fallback) ? fallback : "default" };
      }
    }
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

  // 4. Deterministic plan<->SQL gates (code is authoritative over LLM labels).
  // Complexity is derived from the SQL shape, never trusted from the planner.
  // Rule coverage catches planner-says-COMMITTED / writer-forgets-filter drift.
  const deterministicComplexity = calculateComplexity(candidateSql, final.tablesUsed);
  const appliedRuleIds = final.appliedRuleIds ?? [];
  const planWarnings: string[] = [];
  const planUnresolved: string[] = [...final.unresolved];
  if (deterministicComplexity !== final.complexity) {
    planWarnings.push(
      `Complexity corrected from '${final.complexity}' to '${deterministicComplexity}' by deterministic classification.`
    );
  }
  const sqlTables = extractSqlTables(candidateSql);
  const drift = findTableDrift(final.tablesUsed, sqlTables);
  if (drift) planUnresolved.push(`PLAN_SQL_DRIFT (${drift})`);
  for (const missing of findMissingRuleClauses(appliedRuleIds, candidateSql, snapshot)) {
    planUnresolved.push(`RULE_NOT_APPLIED (${missing} declared by planner but absent from SQL)`);
  }
  // Fail-closed: the writer must never invent filters beyond the plan. A
  // status predicate without a declared business rule silently changes the
  // question (all cases vs committed cases), so reject instead of certifying
  // wrong semantics as success.
  if (hasUndeclaredStatusFilter(appliedRuleIds, candidateSql)) {
    const envelope = composeResponse({
      kind: "error",
      dialect: request.dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: null,
      blockedMessage: null,
      error: "SQL certification failed: writer added a TEST_CASE_STATUS filter with no declared business rule (appliedRuleIds is empty). Rephrase with explicit status intent if a status filter is wanted.",
      warnings: [...final.warnings, ...staticRes.warnings, ...planWarnings],
      unresolved: [...planUnresolved, "UNDECLARED_STATUS_FILTER"],
      filteringMetadata,
      domain: final.domain,
      intent: final.intent,
      complexity: deterministicComplexity,
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

  // 5. Success: neutral + dialect render, then deterministic AST in code.
  // The writer is SQL-only; sqlToAstV2 builds the AST v2 JSON from the
  // certified SQL without LLM tokens. Legacy LLM AST (final.ast) is only a
  // fallback when the deterministic builder reports unsupported.
  const neutral = toDbNeutral(candidateSql);
  const rendered = renderDialect(neutral, request.dialect);
  let ast: unknown | null = null;
  const astUnresolved: string[] = [...final.unresolved];
  let rawAst: unknown = final.ast;
  if (typeof rawAst === "string") {
    try { rawAst = JSON.parse(rawAst); } catch (e) {}
  }

  if (!includeAst) {
    // include_ast=false: ast:null is contract-valid via the explicit opt-out.
  } else {
    const built = sqlToAstV2(neutral);
    const candidate: unknown = built.ast ?? (rawAst && typeof rawAst === "object" && !Array.isArray(rawAst) ? rawAst : null);
    if (built.ast === null && candidate === null) {
      const code = built.unsupported ?? "UNSUPPORTED_OPERATION";
      astUnresolved.push(`${AST_FAILED_MARKER} (${code})`);
    } else if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const raw = candidate as Record<string, unknown>;
      if ((raw as Record<string, unknown>).unsupported === true) {
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
      astUnresolved.push(`${AST_FAILED_MARKER} (AST_VALIDATION_FAILED: no AST built from SQL)`);
    }
  }

  const envelope = composeResponse({
    kind: "success",
    dialect: request.dialect.toLowerCase(),
    question: request.question,
    certifiedSql: rendered,
    dbNeutralQuery: neutral,
    ast,
    cert: null,
    conversationalResponse: null,
    blockedMessage: null,
    error: null,
    warnings: [...final.warnings, ...staticRes.warnings, ...planWarnings],
    unresolved: [...astUnresolved, ...planUnresolved.filter((u) => !final.unresolved.includes(u))],
    filteringMetadata,
    domain: final.domain,
    intent: final.intent,
    complexity: deterministicComplexity,
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
