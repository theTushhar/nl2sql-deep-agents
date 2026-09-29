// Shared request/result types for the deep-agents coordinator.
// (Moved from the old deterministic coordinator; the HTTP contract is unchanged.)

import type { ProdEnvelope } from "../contracts/query-envelope";
import type { ComposerKind } from "../orchestration/response-composer";

export interface TimeContext {
  time_zone?: string;
  now?: string;
  week_starts_on?: string;
}

export interface AnswerRequest {
  /** Caller metadata echoed back unchanged (requestId et al). */
  echo: Record<string, unknown>;
  question: string;
  dialect: string;
  /** Client-hinted domain (validated against snapshot; default = auto-route). */
  domain?: string;
  snapshotRef?: string;
  /**
   * AST gate. Default true: the ast-generator subagent runs on success only.
   * Pass false (via `include_ast: false`) to skip it entirely and return
   * `ast: null`. Tune via prompts/ast-generator.prompt.md.
   */
  includeAst?: boolean;
  /** AST contract version requested (default "2.0"). */
  astVersion?: string;
  /**
   * Accepted but currently informational: the AST mirrors the certified SQL
   * projection. Kept for App Engine forward-compat.
   */
  requiredProjection?: { field?: string; output?: string; distinct?: boolean };
  /** Trusted time context from App Engine (time zone + anchor time). */
  timeContext?: TimeContext;
}

export interface AnswerResult {
  envelope: ProdEnvelope;
  kind: ComposerKind;
  traceId: string;
  issues: string[];
}
