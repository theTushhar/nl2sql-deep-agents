import type { ConfigSnapshot } from "../domain/config";
import type { ValidatedPlan } from "./plan-validator";
import type { QueryAstV2 } from "../contracts/query-ast-v2";
import { extractAstTables } from "../domain/ast-validator";
import {
  validateAstShape,
  validateAstCatalogCheck,
  validateAstLimitsCheck,
  validateDomainAst,
  validateBusinessRules,
} from "../domain/dual-validators";
import {
  runWriterBranch,
  repairPrefix,
  type BranchCallOpts,
  type AstWriterResult,
  type BranchResult,
} from "./branches";
import { sanitizeCode, type BranchFail } from "./sql-branch-eval";

export interface AstEvaluationOutput {
  astObj: QueryAstV2 | null;
  astTables: string[];
  astWarn: string[];
  astFail: BranchFail | null;
}

export async function evaluateAstBranch(args: {
  astRes: BranchResult<AstWriterResult> | null;
  plan: ValidatedPlan;
  snapshot: ConfigSnapshot;
  astContract: string;
  mkOpts: () => BranchCallOpts;
}): Promise<AstEvaluationOutput> {
  const { astRes, plan, snapshot, astContract, mkOpts } = args;

  if (!astRes || !("data" in astRes)) {
    return {
      astObj: null,
      astTables: [],
      astWarn: [],
      astFail: {
        kind: "error",
        message: null,
        reasonCode: null,
        detail: !astRes ? "AST branch produced no output." : astRes.error,
      },
    };
  }

  const d = astRes.data;
  if (d.kind !== "success") {
    return {
      astObj: null,
      astTables: [],
      astWarn: [],
      astFail: {
        kind: d.kind,
        message: d.message,
        reasonCode: sanitizeCode(d.reasonCode),
        detail: d.message ?? `AST branch returned ${d.kind}.`,
      },
    };
  }

  if (!d.ast) {
    return {
      astObj: null,
      astTables: [],
      astWarn: [],
      astFail: { kind: "error", message: null, reasonCode: null, detail: "AST writer succeeded with null AST." },
    };
  }

  const checkAst = (ast: unknown): { issues: string[]; parsed: QueryAstV2 | null } => {
    const issues: string[] = [];
    const shape = validateAstShape(ast);
    if (!shape.ast) {
      issues.push(...shape.issues);
      return { issues, parsed: null };
    }
    const parsed = shape.ast;
    issues.push(...validateAstCatalogCheck(parsed, snapshot));
    issues.push(...validateAstLimitsCheck(parsed));
    issues.push(...validateDomainAst(parsed, { domain: plan.domain, requiredProjection: plan.requiredProjection ?? undefined }));
    issues.push(...validateBusinessRules(parsed, plan.appliedRuleIds, snapshot));
    return { issues, parsed };
  };

  let candidateAst: unknown = d.ast;
  let { issues, parsed } = checkAst(candidateAst);
  let warnings = [...(d.warnings ?? [])];

  if (issues.length > 0) {
    const repairPrompt = `${repairPrefix("ast-writer")}\n${astContract}\nFailed AST:\n${JSON.stringify(candidateAst)}\nIssues:\n${issues.join("\n")}`;
    const repRes = await runWriterBranch("ast-writer", repairPrompt, mkOpts());
    if (repRes && "data" in repRes) {
      const repData = repRes.data as AstWriterResult;
      if (repData.kind === "success" && repData.ast) {
        const recheck = checkAst(repData.ast);
        if (recheck.issues.length === 0 && recheck.parsed) {
          parsed = recheck.parsed;
          issues = [];
          warnings.push(...(repData.warnings ?? []));
        } else {
          issues = recheck.issues;
        }
      }
    }
  }

  if (issues.length > 0 || !parsed) {
    return {
      astObj: null,
      astTables: [],
      astWarn: warnings,
      astFail: {
        kind: "error",
        message: null,
        reasonCode: null,
        detail: `AST validation failed: ${issues.join("; ")}`,
      },
    };
  }

  return {
    astObj: parsed,
    astTables: extractAstTables(parsed),
    astWarn: warnings,
    astFail: null,
  };
}
