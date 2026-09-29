// Regression: every toolStrategy responseFormat MUST convert to tool
// parameters with top-level type "object". A union converts to `{anyOf}`
// with no top-level type, and OpenAI rejects the whole model call with 400
// invalid_function_parameters ("got type None") — observed in production as
// `Invalid schema for function 'extract-N'` on the ast-generator subagent,
// wasting the entire 83s pipeline run. Pure conversion check, no LLM.
import { describe, it, expect } from "vitest";
import {
  AstResponse,
  CriticResponse,
  ExplorerResponse,
  FinalAnswerResponse,
  GuardrailResponse,
  InterpreterResponse,
  NormalizerResponse,
  RephraserResponse,
  RouterResponse,
  WriterResponse,
} from "./schemas";

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
    GuardrailResponse,
    NormalizerResponse,
    RouterResponse,
    RephraserResponse,
    ExplorerResponse,
    InterpreterResponse,
    WriterResponse,
    CriticResponse,
    AstResponse,
    FinalAnswerResponse,
  };
  for (const [name, response] of Object.entries(cases)) {
    it(`${name} converts to top-level type object`, () => {
      expect(toolParametersType(response)).toBe("object");
    });
  }
});
