// Shared request/result types for the deep-agents coordinator.
// Strictly typed per the Query AI AST v2 contract: no echo passthrough.

import type { ProdEnvelope } from "../contracts/query-envelope";
import type { ComposerKind } from "../domain/response-composer";

export interface TimeContext {
  time_zone?: string;
  now?: string;
  week_starts_on?: string;
}

export interface AnswerRequest {
  /** Caller request id (server fills a fallback when absent). */
  requestId: string;
  /** Caller thread/correlation id (server fills a fallback when absent). */
  threadId: string;
  /** Optional user id for tracing attribution. */
  userId?: string;
  question: string;
  dialect: string;
  /** Client-hinted domain (validated against snapshot; default = auto-route). */
  domain?: string;
  snapshotRef?: string;
  /**
   * AST gate. Default true: the writer subagent returns AST v2 JSON alongside
   * the SQL on success. Pass false (via `include_ast: false`) to skip it and
   * return `ast: null`. Tune via prompts/writer.prompt.md.
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
