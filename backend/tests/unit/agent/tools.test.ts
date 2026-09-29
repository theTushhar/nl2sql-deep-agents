// Unit tests for snapshot tools: domain partitioning + skill routing.
// Pure reads over DEFAULT_SNAPSHOT — no LLM, no network.
import { describe, it, expect } from "vitest";
import { findTablesTool, listBusinessRulesTool, listDomainsTool } from "../../../src/agent/tools";

describe("list_business_rules domain partition", () => {
  it("returns only the requested domain's rules", async () => {
    const raw = await listBusinessRulesTool.invoke({ domain: "all_test_sets" });
    const { rules } = JSON.parse(String(raw)) as { rules: Array<{ domain: string }> };
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.domain === "all_test_sets")).toBe(true);
  });

  it("returns nothing for an unknown domain", async () => {
    const raw = await listBusinessRulesTool.invoke({ domain: "nope" });
    expect(JSON.parse(String(raw)).rules).toEqual([]);
  });

  it("omitting the domain returns everything (back-compat)", async () => {
    const raw = await listBusinessRulesTool.invoke({});
    expect(JSON.parse(String(raw)).rules.length).toBeGreaterThan(0);
  });
});

describe("list_domains skill routing", () => {
  it("exposes each domain's skill packs for the writer", async () => {
    const raw = await listDomainsTool.invoke({});
    const { domains } = JSON.parse(String(raw)) as {
      domains: Array<{ canonical_name: string; skills: string[] }>;
    };
    expect(
      domains.find((d) => d.canonical_name === "all_test_sets")?.skills
    ).toEqual(["all-test-sets"]);
  });
});

describe("find_tables allow-list", () => {
  it("returns the domain allow-list verbatim", async () => {
    const raw = await findTablesTool.invoke({ domain: "all_test_sets" });
    expect(JSON.parse(String(raw)).tables).toEqual([
      "TEST_SET",
      "TEST_CASE",
      "TEST_CASE_STEP",
    ]);
  });
});
