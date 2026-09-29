// Regression: every toolStrategy responseFormat MUST convert to tool
// parameters with top-level type "object". A union converts to `{anyOf}`
// with no top-level type, and OpenAI rejects the whole model call with 400
// invalid_function_parameters ("got type None") — observed in production as
// `Invalid schema for function 'extract-N'`, wasting the entire pipeline run.
// Pure conversion check, no LLM.
import { describe, it, expect } from "vitest";
import {
  CheckerResponse,
  FinalAnswerResponse,
  PlannerResponse,
  WriterResponse,
} from "../../../src/agent/schemas";

function toolParametersType(response: unknown): unknown {
  const wrapped = response as Array<{
    tool: { function: { parameters: { type?: unknown } } };
  }>;
  expect(Array.isArray(wrapped)).toBe(true);
  expect(wrapped.length).toBeGreaterThan(0);
  return wrapped[0].tool.function.parameters.type;
}

describe("responseFormat tool parameters", () => {
  const cases = {
    PlannerResponse,
    WriterResponse,
    CheckerResponse,
    FinalAnswerResponse,
  };
  for (const [name, response] of Object.entries(cases)) {
    it(`${name} converts to top-level type object`, () => {
      expect(toolParametersType(response)).toBe("object");
    });
  }
});
