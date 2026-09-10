import type { ConfigSnapshot } from "../domain/config";
import type { ComposerKind, ComposerInput } from "../domain/response-composer";
import type { RequestTrace } from "./tracing";
import { createLlmRecorder } from "./recorder";
import { loadDomainContext } from "../domain/domain-loader";
import { effectiveTables, hasTemporalExpression } from "../domain/domains";
import { buildTimeContextText } from "../domain/ast-validator";
import { calculateComplexity } from "../domain/query-plan";
import {
  runPlannerBranch,
  runWriterBranch,
  validatePlan,
  buildSqlContract,
  buildAstContract,
  type BranchCallOpts,
  type SqlWriterResult,
  type AstWriterResult,
} from "./branches";
import { evaluateSqlBranch } from "./sql-branch-eval";
import { evaluateAstBranch } from "./ast-branch-eval";
import { evaluateReconciliation } from "./reconciliation-eval";
import type { AnswerRequest } from "./types";

export interface PipelineExecutionArgs {
  request: AnswerRequest;
  snapshot: ConfigSnapshot;
  dialect: string;
  includeSql: boolean;
  includeAst: boolean;
  trace: RequestTrace | null;
  signal: AbortSignal;
  plannerRec: ReturnType<typeof createLlmRecorder>;
  sqlRec: ReturnType<typeof createLlmRecorder>;
  astRec: ReturnType<typeof createLlmRecorder>;
}

export type PipelineOutput = {
  kind: ComposerKind;
  input: Omit<ComposerInput, "stages" | "traceId" | "latencyMs" | "llmTraces" | "configSnapshotRef" | "modelsLive">;
};

export async function executePipeline(args: PipelineExecutionArgs): Promise<PipelineOutput> {
  const { request, snapshot, dialect, includeSql, includeAst, trace, signal, plannerRec, sqlRec, astRec } = args;

  const baseTags = trace?.tags ?? ["deep-agents", "nl2sql"];
  const langfuseCallback = trace?.createCallback() ?? null;

  const mkOpts = (branchTag: string, recorder: ReturnType<typeof createLlmRecorder>, runName: string): BranchCallOpts => ({
    requestId: request.requestId,
    threadId: request.threadId,
    branchTag,
    signal,
    recorder,
    langfuseCallback,
    runName,
    tags: baseTags,
  });

  const domainLower = (request.domain || "default").toLowerCase();
  const allowedHint = effectiveTables(snapshot, domainLower, []);
  const candidateTables = (allowedHint.length > 0 ? allowedHint : snapshot.tables.map((t) => t.table_name)).join(", ") || "(none)";
  const timeText = hasTemporalExpression(request.question) ? buildTimeContextText(request.timeContext) : "none";

  const domainCtx = loadDomainContext(domainLower);
  const contextParts = [
    `Plan: ${request.question}.`,
    `domain_hint=${domainLower}.`,
    `candidateTables=${candidateTables}.`,
    `dialect=${dialect}.`,
    `snapshot=${snapshot.ref}.`,
    `include_sql=${includeSql}.`,
    `include_ast=${includeAst}.`,
    `requiredProjection=${request.requiredProjection ? JSON.stringify(request.requiredProjection) : "none"}.`,
    `time context: ${timeText}.`,
  ];
  if (domainCtx.schema) contextParts.push(`\n[DOMAIN TABLES SCHEMA]:\n${domainCtx.schema}`);
  if (domainCtx.rules) contextParts.push(`\n[DOMAIN BUSINESS RULES]:\n${domainCtx.rules}`);

  const plannerMsg = contextParts.join(" ");
  const planRes = trace
    ? await trace.runWithContext(() => runPlannerBranch(plannerMsg, mkOpts("planner", plannerRec, "branch-planner")))
    : await runPlannerBranch(plannerMsg, mkOpts("planner", plannerRec, "branch-planner"));

  if (!("data" in planRes)) throw new Error(planRes.error);
  const checked = validatePlan(planRes.data, {
    question: request.question,
    domainHint: domainLower,
    requiredProjection: request.requiredProjection,
    snapshot,
  });
  if (!("plan" in checked)) throw new Error(checked.error);
  const plan = checked.plan;

  if (plan.kind !== "data_query") {
    const kind: ComposerKind = plan.kind === "malicious" ? "blocked" : "conversational";
    return {
      kind,
      input: {
        kind,
        dialect,
        certifiedSql: null,
        cert: null,
        conversationalResponse: null,
        blockedMessage: null,
        error: kind === "blocked" ? `Blocked intent: ${plan.kind}` : null,
        warnings: plan.warnings,
        unresolved: plan.unresolved,
        filteringMetadata: null,
        domain: plan.domain,
        intent: plan.kind,
        complexity: "simple",
        tablesUsed: [],
        triggers: [],
        retryCounts: {},
      },
    };
  }

  const sqlContract = buildSqlContract(plan, dialect, timeText);
  const astContract = buildAstContract(plan, timeText);

  const [sqlRes, astRes] = await Promise.all([
    includeSql
      ? trace
        ? trace.runWithContext(() => runWriterBranch("sql-writer", sqlContract, mkOpts("sql-writer", sqlRec, "branch-sql-writer")))
        : runWriterBranch("sql-writer", sqlContract, mkOpts("sql-writer", sqlRec, "branch-sql-writer"))
      : Promise.resolve(null),
    includeAst
      ? trace
        ? trace.runWithContext(() => runWriterBranch("ast-writer", astContract, mkOpts("ast-writer", astRec, "branch-ast-writer")))
        : runWriterBranch("ast-writer", astContract, mkOpts("ast-writer", astRec, "branch-ast-writer"))
      : Promise.resolve(null),
  ]);

  const allowedTables = effectiveTables(snapshot, plan.domain, []);

  const [sqlEval, astEval] = await Promise.all([
    includeSql
      ? evaluateSqlBranch({
          sqlRes: sqlRes as any,
          plan,
          dialect,
          allowedTables,
          snapshot,
          sqlContract,
          mkOpts: () => mkOpts("sql-writer-repair", sqlRec, "branch-sql-writer-repair"),
        })
      : Promise.resolve({ sqlText: null, sqlTables: [], sqlWarn: [], sqlFail: null }),
    includeAst
      ? evaluateAstBranch({
          astRes: astRes as any,
          plan,
          snapshot,
          astContract,
          mkOpts: () => mkOpts("ast-writer-repair", astRec, "branch-ast-writer-repair"),
        })
      : Promise.resolve({ astObj: null, astTables: [], astWarn: [], astFail: null }),
  ]);

  let kind: ComposerKind = "success";
  let error: string | null = null;
  const warnings = [...plan.warnings, ...sqlEval.sqlWarn, ...astEval.astWarn];
  const unresolved = [...plan.unresolved];

  if (includeSql && sqlEval.sqlFail) {
    if (sqlEval.sqlFail.kind === "unsupported") kind = "unsupported";
    else if (sqlEval.sqlFail.kind === "clarification_required") kind = "clarification_required";
    else kind = "error";
    error = sqlEval.sqlFail.detail;
    unresolved.push("SQL_BRANCH_FAILED");
  }

  if (includeAst && astEval.astFail) {
    if (kind === "success") {
      if (astEval.astFail.kind === "unsupported") kind = "unsupported";
      else if (astEval.astFail.kind === "clarification_required") kind = "clarification_required";
      else kind = "error";
    }
    if (!error) error = astEval.astFail.detail;
    unresolved.push("AST_BRANCH_FAILED");
  }

  let finalAst: unknown = astEval.astObj;
  if (kind === "success" && includeSql && includeAst && sqlEval.sqlText && astEval.astObj) {
    const recon = evaluateReconciliation({ sql: sqlEval.sqlText, ast: astEval.astObj, snapshot });
    warnings.push(...recon.warnings);
    if (!recon.ok) {
      warnings.push(recon.disagreementReason ?? "SQL and AST semantic disagreement.");
      unresolved.push("AST_VALIDATION_FAILED (AST_BRANCH_EMPTY)");
      finalAst = null;
    }
  }

  const allTables = Array.from(new Set([...sqlEval.sqlTables, ...astEval.astTables]));
  const derivedComplexity = calculateComplexity(sqlEval.sqlText || "", allTables);

  return {
    kind,
    input: {
      kind,
      dialect,
      certifiedSql: sqlEval.sqlText,
      cert: null,
      conversationalResponse: null,
      blockedMessage: null,
      error,
      warnings,
      unresolved,
      filteringMetadata: null,
      domain: plan.domain,
      intent: plan.intent,
      complexity: derivedComplexity,
      tablesUsed: allTables,
      triggers: [],
      retryCounts: {},
      ast: finalAst,
    },
  };
}
