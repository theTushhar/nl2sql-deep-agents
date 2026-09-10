import type { ConfigSnapshot } from "../domain/config";
import type { QueryAstV2 } from "../contracts/query-ast-v2";
import { compareSqlAndAstSemantics, GENERATION_DISAGREEMENT } from "../domain/dual-validators";

export interface ReconciliationOutput {
  ok: boolean;
  warnings: string[];
  disagreementReason: string | null;
}

export function evaluateReconciliation(args: {
  sql: string;
  ast: QueryAstV2;
  snapshot: ConfigSnapshot;
}): ReconciliationOutput {
  const { sql, ast } = args;
  const warnings: string[] = [];

  const issues = compareSqlAndAstSemantics(sql, ast);
  if (issues.length > 0) {
    return {
      ok: false,
      warnings,
      disagreementReason: `${GENERATION_DISAGREEMENT}: ${issues.join("; ")}`,
    };
  }

  return {
    ok: true,
    warnings,
    disagreementReason: null,
  };
}
