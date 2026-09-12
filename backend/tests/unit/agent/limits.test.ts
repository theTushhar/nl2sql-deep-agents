// Unit tests for per-agent LLM call budgets. Pure env parsing, no LLM.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_COORDINATOR_LLM_CALL_LIMIT,
  DEFAULT_SUBAGENT_LLM_CALL_LIMIT,
  llmCallLimitFor,
} from "../../../src/agent/limits";

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k === "AGENT_LLM_CALL_LIMIT" || k.startsWith("LLM_CALL_LIMIT_")) {
      SAVED[k] = process.env[k];
      delete process.env[k];
    }
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete SAVED[k];
  }
});

describe("llmCallLimitFor", () => {
  it("defaults to 3 for subagents", () => {
    expect(llmCallLimitFor("writer", DEFAULT_SUBAGENT_LLM_CALL_LIMIT)).toBe(3);
  });

  it("defaults to 16 for the coordinator", () => {
    expect(llmCallLimitFor("coordinator", DEFAULT_COORDINATOR_LLM_CALL_LIMIT)).toBe(16);
  });

  it("AGENT_LLM_CALL_LIMIT overrides every agent", () => {
    process.env.AGENT_LLM_CALL_LIMIT = "5";
    expect(llmCallLimitFor("writer", DEFAULT_SUBAGENT_LLM_CALL_LIMIT)).toBe(5);
    expect(llmCallLimitFor("coordinator", DEFAULT_COORDINATOR_LLM_CALL_LIMIT)).toBe(5);
  });

  it("LLM_CALL_LIMIT_<STAGE> wins over the global default", () => {
    process.env.AGENT_LLM_CALL_LIMIT = "5";
    process.env.LLM_CALL_LIMIT_WRITER = "7";
    expect(llmCallLimitFor("writer", DEFAULT_SUBAGENT_LLM_CALL_LIMIT)).toBe(7);
    expect(llmCallLimitFor("checker", DEFAULT_SUBAGENT_LLM_CALL_LIMIT)).toBe(5);
  });

  it("ignores non-positive and non-numeric values", () => {
    process.env.LLM_CALL_LIMIT_WRITER = "0";
    expect(llmCallLimitFor("writer", DEFAULT_SUBAGENT_LLM_CALL_LIMIT)).toBe(3);
    process.env.LLM_CALL_LIMIT_WRITER = "many";
    expect(llmCallLimitFor("writer", DEFAULT_SUBAGENT_LLM_CALL_LIMIT)).toBe(3);
  });
});
