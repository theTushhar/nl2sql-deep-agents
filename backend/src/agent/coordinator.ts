import { loadSnapshot } from "../domain/config";
import type { ProdEnvelope } from "../contracts/query-envelope";
import { composeResponse, type ComposerKind, type StageRecord } from "../domain/response-composer";
import { validateEnvelope } from "../contracts/envelope-validator";
import { toDbNeutral, renderDialect } from "../domain/sql-ast";
import { startRequestTrace, flushTracing } from "./tracing";
import { createLlmRecorder, type DrainedLlm } from "./recorder";
import { getPromptVersions } from "../domain/domains";
import { readModelName } from "./model";
import type { AnswerRequest, AnswerResult } from "./types";
import { executePipeline } from "./pipeline-executor";
import { failureMarker } from "./final-answer-helper";

export { flushTracing };
export type { AnswerRequest, AnswerResult };
export type { TimeContext } from "./types";
export { extractFinalAnswerFallback, normalizeFinalAnswer } from "./final-answer-helper";

export const AST_FAILED_MARKER = "AST_VALIDATION_FAILED";
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 120000;
export const AGENT_RECURSION_LIMIT = Number(process.env.AGENT_RECURSION_LIMIT) || 80;

const UNSUPPORTED_DIALECT_MESSAGE =
  "The requested query dialect is not supported. Please request the mysql dialect, and rephrase your question as a data question about your test sets, test cases, or test runs.";

export async function answerQuestion(request: AnswerRequest): Promise<AnswerResult> {
  const started = Date.now();
  const requestId = request.requestId;
  const threadId = request.threadId;
  const userId = request.userId;
  const issues: string[] = [];
  const snapshot = loadSnapshot(request.snapshotRef);
  const dialect = (request.dialect || "mysql").toLowerCase();
  const stages: Record<string, StageRecord> = {};
  const includeAst = request.includeAst !== false;
  const includeSql = request.includeSql !== false;
  const promptVersions = getPromptVersions(request.domain || "default");

  const trace = startRequestTrace({
    requestId,
    threadId,
    userId,
    question: request.question,
    dialect,
    domain: request.domain,
  });
  const traceId = trace?.traceId || requestId;

  const plannerRec = createLlmRecorder();
  const sqlRec = createLlmRecorder();
  const astRec = createLlmRecorder();

  const drainBranch = (rec: ReturnType<typeof createLlmRecorder>, stage: string): DrainedLlm => {
    const d = rec.drain();
    stages[stage] = {
      model: readModelName(),
      latencyMs: Date.now() - started,
      costUsd: 0,
      tokensIn: d.tokensIn,
      tokensOut: d.tokensOut,
    };
    return d;
  };

  const finish = (kind: ComposerKind, envelope: ProdEnvelope): AnswerResult => {
    const envelopeIssues = validateEnvelope(envelope, kind, { includeAst, includeSql });
    if (envelopeIssues.length > 0) {
      const summary = envelopeIssues.map((i) => `${i.path}: ${i.message}`).join("; ");
      issues.push(`Envelope validation: ${summary}`);
    }
    trace?.end({ kind, traceId }, kind);
    return { envelope, kind, traceId, issues };
  };

  if (!includeAst && !includeSql) {
    const envelope = composeResponse({
      kind: "error",
      dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: null,
      blockedMessage: null,
      error: "Both include_ast and include_sql are false: at least one output branch must be enabled.",
      warnings: [],
      unresolved: ["DUAL_OUTPUT_DISABLED"],
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
      promptVersions,
      modelsLive: true,
    });
    return finish("error", envelope);
  }

  if (!snapshot.supportedDialects.includes(dialect)) {
    const envelope = composeResponse({
      kind: "error",
      dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: null,
      blockedMessage: null,
      error: UNSUPPORTED_DIALECT_MESSAGE,
      warnings: [],
      unresolved: ["DIALECT_NOT_SUPPORTED"],
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
      promptVersions,
      modelsLive: true,
    });
    return finish("error", envelope);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const pipelineOut = await executePipeline({
      request,
      snapshot,
      dialect,
      includeSql,
      includeAst,
      trace,
      signal: controller.signal,
      plannerRec,
      sqlRec,
      astRec,
    });

    clearTimeout(timeout);
    const p = drainBranch(plannerRec, "planner");
    const s = drainBranch(sqlRec, "sql-writer");
    const a = drainBranch(astRec, "ast-writer");

    const llmTraces = [...p.llmTraces, ...s.llmTraces, ...a.llmTraces];

    let certifiedSql = pipelineOut.input.certifiedSql;
    let dbNeutralQuery: string | null = null;
    if (certifiedSql) {
      try {
        dbNeutralQuery = toDbNeutral(certifiedSql);
        certifiedSql = renderDialect(dbNeutralQuery, dialect);
      } catch {
        dbNeutralQuery = null;
      }
    }

    const envelope = composeResponse({
      ...pipelineOut.input,
      certifiedSql,
      dbNeutralQuery,
      dialect,
      stages,
      traceId,
      latencyMs: Date.now() - started,
      llmTraces,
      configSnapshotRef: snapshot.ref,
      promptVersions,
      modelsLive: true,
    });

    return finish(pipelineOut.kind, envelope);
  } catch (err) {
    clearTimeout(timeout);
    drainBranch(plannerRec, "planner");
    drainBranch(sqlRec, "sql-writer");
    drainBranch(astRec, "ast-writer");

    const marker = failureMarker(err);
    const envelope = composeResponse({
      kind: "error",
      dialect,
      certifiedSql: null,
      cert: null,
      conversationalResponse: null,
      blockedMessage: null,
      error: "An unexpected error occurred during query generation.",
      warnings: [],
      unresolved: [marker],
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
      promptVersions,
      modelsLive: true,
    });

    return finish("error", envelope);
  }
}
