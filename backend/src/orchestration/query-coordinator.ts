// Query coordinator: deterministic orchestration around LLM agents.
// Responsibilities: todo sequencing, delegation order with conditional
// skips, budget enforcement, envelope assembly via the composer.
// The coordinator NEVER authors SQL: the only SQL it can emit is the
// critic-certified string passed through from the certify gate.
//
// Order: guardrail -> (blocked | debugger) -> router ->
// (explorer + interpreter in parallel) -> certify gate -> composer.
// Explorer and interpreter are independent: they run concurrently.

import { randomUUID } from "crypto";
import { loadSnapshot } from "../config/domain-config";
import type { TriggerRecord } from "../tools/snapshot-tools";
import type { ProdEnvelope } from "../contracts/query-envelope";
import { analyzeGuardrail } from "../agents/input-guard.agent";
import { normalizeQuery } from "../agents/query-normalizer.agent";
import { routeDomain } from "../agents/domain-router.agent";
import { exploreSchema } from "../agents/schema-explorer.agent";
import { interpretRules } from "../agents/business-rules.agent";
import { certifySql, MAX_ROUNDS } from "./certification-gate";
import { composeResponse, type ComposerKind, type StageRecord } from "../agents/response-composer";
import { defaultMiddlewareConfig } from "./pipeline-middleware";
import { validateEnvelope } from "../contracts/envelope-validator";
import { startTrace, endTrace } from "./llm-client";
import { runInTraceContext, takeTraceRecords } from "./observability";
import { buildAstTool, toDbNeutral, renderDialect, tablesUsedFromAst, type AstV1Clean } from "./sql-ast";

export interface AnswerRequest {
  /** Caller metadata echoed back unchanged (requestId et al). */
  echo: Record<string, unknown>;
  question: string;
  dialect: string;
  /** Client-hinted domain (validated against snapshot; default = auto-route). */
  domain?: string;
  snapshotRef?: string;
  /**
   * AST tool gate (v1-clean). Default true: the buildAstTool runs on every
   * success. Pass false (via `include_ast: false`) to skip the tool call
   * entirely and return `ast: null`.
   */
  includeAst?: boolean;
}

export interface AnswerResult {
  envelope: ProdEnvelope;
  kind: ComposerKind;
  traceId: string;
  issues: string[];
}

const UNSUPPORTED_DIALECT_MESSAGE =
  "The requested query dialect is not supported. Please request the mysql dialect, and rephrase your question as a data question about your test sets, test cases, or test runs.";

export async function answerQuestion(request: AnswerRequest): Promise<AnswerResult> {
  const started = Date.now();
  const echo = request.echo || {};
  const requestId =
    typeof echo.requestId === "string" && echo.requestId
      ? echo.requestId
      : randomUUID();
  const threadId =
    typeof echo.threadId === "string" && echo.threadId ? echo.threadId : undefined;
  // Caller identity is echoed for tracing only. User/tenant scoping is owned
  // by the consuming service, so the generator never invents identity-based
  // predicates — SQL comes strictly from the column mapping.
  const userId =
    (typeof echo.user_id === "string" && echo.user_id) ||
    (typeof echo.userId === "string" && echo.userId) ||
    undefined;
  const trace = startTrace("answer-question", {
    requestId,
    threadId,
    userId,
    dialect: request.dialect,
  });
  // Prefer the Langfuse trace id; fall back to the caller request id when
  // tracing is disabled so telemetry.traceId is always populated.
  const traceId = trace?.traceId || requestId;
  const recordKey = trace?.recordKey || randomUUID();
  const issues: string[] = [];

  const snapshot = loadSnapshot(request.snapshotRef);
  const dialect = request.dialect.toLowerCase();
  const stages: Record<string, StageRecord> = {};
  const triggers: TriggerRecord[] = [];
  let delegations = 0;
  const noteDelegation = (name: string, count: number): void => {
    delegations++;
    if (delegations > defaultMiddlewareConfig.maxDelegations) {
      issues.push(`Delegation budget exceeded at ${name}.`);
    }
    if (count > defaultMiddlewareConfig.maxToolCallsPerSubagent) {
      issues.push(`Tool-call budget exceeded in ${name} (${count}).`);
    }
  };
  const recordStage = (
    name: string,
    rec: { model: string; latencyMs: number; costUsd: number; tokensIn: number; tokensOut: number }
  ): void => {
    stages[name] = { model: rec.model, latencyMs: rec.latencyMs, costUsd: rec.costUsd, tokensIn: rec.tokensIn, tokensOut: rec.tokensOut };
  };

  const finish = (
    kind: ComposerKind,
    envelope: ProdEnvelope
  ): AnswerResult => {
    // P0-5 (advisory first step): validate the frozen envelope on the live
    // path. Log-only for now — fail-closed enforcement is a follow-up once
    // golden coverage proves zero false positives. Never changes the payload.
    const envelopeIssues = validateEnvelope(envelope, kind);
    if (envelopeIssues.length > 0) {
      const summary = envelopeIssues.map((i) => `${i.path}: ${i.message}`).join("; ");
      console.warn(`[contract] envelope issues (${kind}): ${summary}`);
      issues.push(`Envelope validation: ${summary}`);
    }
    // Attach the per-request LLM call records (drained exactly once here)
    // so the API response carries full llmTraces even when Langfuse is off.
    envelope.telemetry.llmTraces = takeTraceRecords(recordKey);
    endTrace(trace, { kind, traceId });
    return { envelope, kind, traceId, issues };
  };

  // The entire pipeline runs inside the trace context so every child
  // generation attaches to the parent trace (no orphan root traces),
  // including the parallel explorer + interpreter branch.
  return runInTraceContext(trace, recordKey, async (): Promise<AnswerResult> => {

  // Dialect gate (exact allowlist check, not intent guessing).
  if (!snapshot.supportedDialects.includes(dialect)) {
    // P1-6: tag early exits so dashboard filtering works for blocked turns too.
    trace?.update({
      tags: ["deep-agents", "nl2sql", dialect, "domain:default"],
      metadata: { domain: "default" },
    });
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
      triggers,
      retryCounts: {},
      traceId,
      latencyMs: Date.now() - started,
      configSnapshotRef: snapshot.ref,
      modelsLive: false,
    });
    return finish("blocked", envelope);
  }

  // 1. Guardrail analyst.
  const guard = await analyzeGuardrail({ question: request.question, snapshot });
  noteDelegation("guardrail", 0);
  recordStage("guardrail", guard);

  if (guard.verdict === "block" && (guard.intent_type === "malicious" || guard.intent_type === "out_of_scope")) {
    // Length-gate blocks arrive as out_of_scope with a formal message.
    // (P2-3: removed dead self-ternary that rendered the same arm twice.)
    // P1-6: tag early exits so dashboard filtering works for blocked turns too.
    trace?.update({
      tags: ["deep-agents", "nl2sql", dialect, "domain:default"],
      metadata: { domain: "default" },
    });
    const envelope = composeResponse({
      kind: "blocked",
      requestEcho: request.echo,
      dialect: request.dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: null,
      blockedMessage: guard.formalMessage,
      error: guard.intent_type === "malicious" ? "Request blocked by policy." : null,
      warnings: [],
      unresolved: [],
      filteringMetadata: null,
      domain: "default",
      intent: guard.intent_type,
      complexity: "simple",
      tablesUsed: [],
      stages,
      triggers,
      retryCounts: {},
      traceId,
      latencyMs: Date.now() - started,
      configSnapshotRef: snapshot.ref,
      modelsLive: guard.live,
    });
    return finish("blocked", envelope);
  }

  // 2. Query debugger (canonicalization; chitchat resolves here).
  const debug = await normalizeQuery({ question: request.question, snapshot });
  noteDelegation("debugger", 0);
  recordStage("debugger", debug);

  if (debug.isConversational) {
    // P1-6: tag early exits so dashboard filtering works for conversational turns too.
    trace?.update({
      tags: ["deep-agents", "nl2sql", dialect, `domain:${debug.domain}`],
      metadata: { domain: debug.domain },
    });
    const envelope = composeResponse({
      kind: "conversational",
      requestEcho: request.echo,
      dialect: request.dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: debug.conversationalResponse,
      blockedMessage: null,
      error: null,
      warnings: [],
      unresolved: [],
      filteringMetadata: null,
      domain: debug.domain,
      intent: debug.intent,
      complexity: "simple",
      tablesUsed: [],
      stages,
      triggers,
      retryCounts: {},
      traceId,
      latencyMs: Date.now() - started,
      configSnapshotRef: snapshot.ref,
      modelsLive: debug.live,
    });
    return finish("conversational", envelope);
  }

  // 3. Domain router — skipped when the caller fixes a registered
  // non-default domain. "default" (or unknown) always auto-routes so a
  // single default query can borrow multi-table schema facts by intent and
  // still render one query (never one query per domain).
  const requestedDomain = typeof request.domain === "string" ? request.domain.trim().toLowerCase() : "";
  const registered = snapshot.domains.find((d) => d.canonical_name.toLowerCase() === requestedDomain);
  let routed: { domain_key: string; sub_domain_key: string | null; confidence: number; reasoning: string; model: string; live: boolean; latencyMs: number; costUsd: number; tokensIn: number; tokensOut: number };
  if (registered && registered.canonical_name.toLowerCase() !== "default") {
    routed = {
      domain_key: registered.canonical_name,
      sub_domain_key: null,
      confidence: 1.0,
      reasoning: "Client-fixed domain; router LLM skipped.",
      model: "client-hint",
      live: false,
      latencyMs: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    recordStage("router", routed);
  } else {
    const r = await routeDomain({ canonical_query: debug.canonical_query, snapshot });
    noteDelegation("router", 0);
    recordStage("router", r);
    routed = r;
  }
  // Tag the parent trace with the resolved domain for dashboard filtering.
  trace?.update({
    tags: ["deep-agents", "nl2sql", dialect, `domain:${routed.domain_key}`],
    metadata: { domain: routed.domain_key },
  });

  // 4. Explorer + interpreter in parallel (independent).
  const [explored, interpreted] = await Promise.all([
    exploreSchema({ canonical_query: debug.canonical_query, domain: routed.domain_key, snapshot }),
    interpretRules({ canonical_query: debug.canonical_query, snapshot }),
  ]);
  noteDelegation("explorer", explored.triggers.length);
  noteDelegation("interpreter", interpreted.triggers.length);
  recordStage("explorer", explored);
  recordStage("interpreter", interpreted);
  triggers.push(...explored.triggers, ...interpreted.triggers);

  // 5. Certification gate (the only SQL exit path).
  // Default domain borrows multi-table schema facts by intent (explorer sees
  // all tables) but never grid projection skills — one single query out.
  const certified = await certifySql({
    canonical_query: debug.canonical_query,
    domain: routed.domain_key,
    dialect: request.dialect,
    relevantTables: explored.relevantTables,
    searchScope: explored.searchScope,
    likePattern: explored.likePattern,
    operator: explored.operator,
    measures: interpreted.measures,
    filters: interpreted.filters,
    orderBy: interpreted.orderBy,
    complexity: explored.complexity,
    snapshot,
  });
  noteDelegation("writer+critic", certified.triggers.length);
  triggers.push(...certified.triggers);
  stages["writer"] = {
    model: certified.skills.join("+"),
    latencyMs: certified.latencyMs,
    costUsd: certified.costUsd,
    tokensIn: certified.tokensIn,
    tokensOut: certified.tokensOut,
  };

  if (!certified.certified || !certified.sql) {
    const envelope = composeResponse({
      kind: "error",
      requestEcho: request.echo,
      dialect: request.dialect,
      certifiedSql: null,
      cert: certified,
      conversationalResponse: null,
      blockedMessage: null,
      // P0-9: cap certification detail (first 3 errors) so failures can't
      // become an oracle for iterative jailbreak refinement.
      error: `SQL certification failed after ${MAX_ROUNDS} attempts: ${certified.errors.slice(0, 3).join("; ")}`,
      warnings: certified.warnings,
      unresolved: certified.unresolved,
      filteringMetadata: {
        measures: interpreted.measures,
        filters: interpreted.filters,
        ordering: interpreted.orderBy,
        tables: explored.relevantTables,
        scope: explored.searchScope.join(", "),
      },
      domain: routed.domain_key,
      intent: debug.intent,
      complexity: explored.complexity,
      tablesUsed: explored.relevantTables,
      stages,
      triggers,
      retryCounts: { writerCritic: certified.attempts },
      traceId,
      latencyMs: Date.now() - started,
      configSnapshotRef: snapshot.ref,
      modelsLive: true,
    });
    return finish("error", envelope);
  }

  // 6. Composer: neutral SQL + optional AST tool, then dialect rendering.
  // certified.sql is the neutral form; render per requested dialect.
  // The AST tool is deterministic (buildAstTool over neutral SQL) and gated
  // by includeAst: false skips the call entirely (ast: null).
  const neutral = toDbNeutral(certified.sql);
  const rendered = renderDialect(neutral, request.dialect);
  const includeAst = request.includeAst !== false;
  // Tracker for the AST tool so the call shows in telemetry.toolTriggers.
  const astTracker = {
    record(name: string, outcome: string): void {
      triggers.push({ name, outcome });
    },
    list(): { name: string; outcome: string }[] {
      return [...triggers];
    },
  };
  let ast: AstV1Clean | null = null;
  if (includeAst) {
    ast = buildAstTool(neutral, astTracker);
  } else {
    triggers.push({ name: "buildAst", outcome: "skipped:include_ast=false" });
  }
  const astTables = ast ? tablesUsedFromAst(ast) : explored.relevantTables;
  const envelope = composeResponse({
    kind: "success",
    requestEcho: request.echo,
    dialect: request.dialect.toLowerCase(),
    question: request.question,
    canonical_query: debug.canonical_query,
    certifiedSql: rendered,
    dbNeutralQuery: neutral,
    // v1-clean: pass the tool output through by reference (omit-when-empty
    // already applied by buildAstTool); null when include_ast=false.
    ast,
    cert: certified,
    conversationalResponse: null,
    blockedMessage: null,
    error: null,
    warnings: certified.warnings,
    unresolved: certified.unresolved,
    filteringMetadata: {
      measures: interpreted.measures,
      filters: interpreted.filters,
      ordering: interpreted.orderBy,
      tables: astTables.length > 0 ? astTables : explored.relevantTables,
      scope: explored.searchScope.join(", "),
    },
    domain: routed.domain_key,
    intent: debug.intent,
    complexity: explored.complexity,
    tablesUsed: astTables.length > 0 ? astTables : explored.relevantTables,
    stages,
    triggers,
    retryCounts: { writerCritic: certified.attempts },
    traceId,
    latencyMs: Date.now() - started,
    configSnapshotRef: snapshot.ref,
    modelsLive: true,
  });
  return finish("success", envelope);
  });
}
