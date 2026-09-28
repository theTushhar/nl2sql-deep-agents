// Middleware stub: planning, subagent scoping, skills layering, file search, todo.
// TODO: implement middleware policies.
export interface MiddlewareConfig {
  maxDelegations: number;
  maxToolCallsPerSubagent: number;
  writerCriticRounds: 2 | 3;
}

export const defaultMiddlewareConfig: MiddlewareConfig = {
  maxDelegations: 12,
  maxToolCallsPerSubagent: 12,
  writerCriticRounds: 3,
};
