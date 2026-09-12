import type { ProdEnvelope } from "../contracts/query-envelope";
import type { ComposerKind } from "../domain/response-composer";

export interface TimeContext {
  time_zone?: string;
  now?: string;
  week_starts_on?: string;
}

export interface AnswerRequest {
  requestId: string;
  threadId: string;
  userId?: string;
  question: string;
  dialect?: string;
  domain?: string;
  snapshotRef?: string;
  includeAst?: boolean;
  includeSql?: boolean;
  astVersion?: string;
  requiredProjection?: { field?: string; output?: string; distinct?: boolean };
  timeContext?: TimeContext;
}

export interface AnswerResult {
  envelope: ProdEnvelope;
  kind: ComposerKind;
  traceId: string;
  issues: string[];
}
