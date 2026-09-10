import type { ConfigSnapshot } from "../domain/config";
import type { ValidatedPlan } from "./plan-validator";
import { runStaticChecks } from "../domain/guardrails";
import { validateSqlDomainContract } from "../domain/dual-validators";
import { findMissingRuleClauses, hasUndeclaredStatusFilter } from "../domain/query-plan";
import { extractSqlTables } from "../domain/ast-validator";
import {
  runWriterBranch,
  repairPrefix,
  type BranchCallOpts,
  type SqlWriterResult,
  type BranchResult,
} from "./branches";

export interface BranchFail {
  kind: "unsupported" | "clarification_required" | "error";
  message: string | null;
  reasonCode: string | null;
  detail: string;
}

export function sanitizeCode(v: string | null): string | null {
  return v ? v.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64) || null : null;
}

export interface SqlEvaluationOutput {
  sqlText: string | null;
  sqlTables: string[];
  sqlWarn: string[];
  sqlFail: BranchFail | null;
}

export async function evaluateSqlBranch(args: {
  sqlRes: BranchResult<SqlWriterResult> | null;
  plan: ValidatedPlan;
  dialect: string;
  allowedTables: string[];
  snapshot: ConfigSnapshot;
  sqlContract: string;
  mkOpts: () => BranchCallOpts;
}): Promise<SqlEvaluationOutput> {
  const { sqlRes, plan, dialect, allowedTables, snapshot, sqlContract, mkOpts } = args;

  if (!sqlRes || !("data" in sqlRes)) {
    return {
      sqlText: null,
      sqlTables: [],
      sqlWarn: [],
      sqlFail: {
        kind: "error",
        message: null,
        reasonCode: null,
        detail: !sqlRes ? "SQL branch produced no output." : sqlRes.error,
      },
    };
  }

  const d = sqlRes.data;
  if (d.kind !== "success") {
    return {
      sqlText: null,
      sqlTables: [],
      sqlWarn: [],
      sqlFail: {
        kind: d.kind,
        message: d.message,
        reasonCode: sanitizeCode(d.reasonCode),
        detail: d.message ?? `SQL branch returned ${d.kind}.`,
      },
    };
  }

  if (!d.sql) {
    return {
      sqlText: null,
      sqlTables: [],
      sqlWarn: [],
      sqlFail: { kind: "error", message: null, reasonCode: null, detail: "SQL writer succeeded with null SQL." },
    };
  }

  const checkSql = (sql: string): string[] => {
    const issues: string[] = [];
    const staticRes = runStaticChecks(sql, allowedTables, [], snapshot, { dialect, domain: plan.domain });
    if (staticRes.errors.length > 0) issues.push(...staticRes.errors);
    issues.push(...validateSqlDomainContract(sql, plan.domain, snapshot));
    if (findMissingRuleClauses(plan.appliedRuleIds, sql, snapshot).length > 0) {
      issues.push("SQL is missing applied rule predicates.");
    }
    if (hasUndeclaredStatusFilter(plan.appliedRuleIds, sql)) {
      issues.push("SQL includes an undeclared status filter.");
    }
    return issues;
  };

  let candidateSql = d.sql;
  let issues = checkSql(candidateSql);
  let warnings = [...(d.warnings ?? [])];

  if (issues.length > 0) {
    const repairPrompt = `${repairPrefix("sql-writer")}\n${sqlContract}\nFailed SQL:\n${candidateSql}\nIssues:\n${issues.join("\n")}`;
    const repRes = await runWriterBranch("sql-writer", repairPrompt, mkOpts());
    if (repRes && "data" in repRes) {
      const repData = repRes.data as SqlWriterResult;
      if (repData.kind === "success" && repData.sql) {
        const recheck = checkSql(repData.sql);
        if (recheck.length === 0) {
          candidateSql = repData.sql;
          issues = [];
          warnings.push(...(repData.warnings ?? []));
        } else {
          issues = recheck;
        }
      }
    }
  }

  if (issues.length > 0) {
    return {
      sqlText: null,
      sqlTables: [],
      sqlWarn: warnings,
      sqlFail: {
        kind: "error",
        message: null,
        reasonCode: null,
        detail: `SQL validation failed: ${issues.join("; ")}`,
      },
    };
  }

  return {
    sqlText: candidateSql,
    sqlTables: extractSqlTables(candidateSql),
    sqlWarn: warnings,
    sqlFail: null,
  };
}
