// Unit tests for the critic's deterministic veto over LLM error claims.
// Pure function (vetoLlmFalsePositives), no LLM calls.
import { describe, it, expect } from "vitest";
import { vetoLlmFalsePositives } from "./sql-critic.agent";
import { DEFAULT_SNAPSHOT } from "../config/domain-config";

const INCIDENT_SQL =
  "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_TYPE = 'Personal' AND (LOWER(ts.TEST_SET_NAME) LIKE 'rock%')";

describe("vetoLlmFalsePositives", () => {
  it("vetoes both incident false positives (wildcard + non-searchable)", () => {
    const { kept, vetoed } = vetoLlmFalsePositives(
      [
        "Wildcard projection or partial column projection is not allowed; only explicit columns from the whitelist are allowed.",
        "LIKE operator used on non-searchable column TEST_SET_NAME; use REGEXP for pattern matching with digits or complex patterns.",
      ],
      INCIDENT_SQL,
      DEFAULT_SNAPSHOT
    );
    expect(kept).toEqual([]);
    expect(vetoed).toHaveLength(2);
  });

  it("keeps genuine errors untouched", () => {
    const { kept, vetoed } = vetoLlmFalsePositives(
      ["Hallucinated table: FOO", "Unknown column 'BAR' on table TEST_SET."],
      INCIDENT_SQL,
      DEFAULT_SNAPSHOT
    );
    expect(kept).toHaveLength(2);
    expect(vetoed).toEqual([]);
  });

  it("keeps a real non-searchable complaint when the predicate is illegal", () => {
    const sql =
      "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_OWNER LIKE '%abc%'";
    const { kept } = vetoLlmFalsePositives(
      ["LIKE predicate on non-searchable column TEST_SET_OWNER."],
      sql,
      DEFAULT_SNAPSHOT
    );
    expect(kept).toHaveLength(1);
  });

  it("keeps a real wildcard complaint when SELECT * is present", () => {
    const sql = "SELECT * FROM TEST_SET ts";
    const { kept } = vetoLlmFalsePositives(["Wildcard projection is not allowed."], sql, DEFAULT_SNAPSHOT);
    expect(kept).toHaveLength(1);
  });
});
