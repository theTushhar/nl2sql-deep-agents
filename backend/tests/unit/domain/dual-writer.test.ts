// Dual-writer migration tests (offline, no LLM).
// Covers FINAL_IMPLEMENTATION_PROMPT test matrix items that are unit-testable.
import { describe, it, expect } from "vitest";
import { isDualOutputDisabled } from "../../../src/api/request-schema";
import { AstWriterSchema, SqlWriterSchema } from "../../../src/agent/schemas";
import { getDomainDefinition, getPromptVersions } from "../../../src/domain/domains";
import {
  validatePlan,
  filterRulesByQuestion,
  buildSqlContract,
  buildAstContract,
  extractBranchJson,
} from "../../../src/agent/branches";
import {
  validateAstShape,
  validateAstCatalogCheck,
  validateDomainAst,
  validateBusinessRules,
  validateSqlDomainContract,
  compareSqlAndAstSemantics,
  GENERATION_DISAGREEMENT,
} from "../../../src/domain/dual-validators";
import { validateEnvelope } from "../../../src/contracts/envelope-validator";
import { composeResponse } from "../../../src/domain/response-composer";
import { DEFAULT_SNAPSHOT } from "../../../src/domain/config";
import { QueryAstV2Schema } from "../../../src/contracts/query-ast-v2";

const VALID_AST = {
  version: "2.0",
  root: { entity: "TEST_SET", alias: "ts" },
  projection: { field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, distinct: true, output: "PARENT_UUID" },
};

const VALID_SQL = "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts GROUP BY ts.TEST_SET_UUID";

describe("output gates", () => {
  it("AST only: AST enabled + SQL disabled is allowed", () => {
    expect(isDualOutputDisabled({ include_ast: true, include_sql: false })).toBe(false);
  });
  it("SQL only: SQL enabled + AST disabled is allowed", () => {
    expect(isDualOutputDisabled({ include_ast: false, include_sql: true })).toBe(false);
  });
  it("both enabled is allowed", () => {
    expect(isDualOutputDisabled({ include_ast: true, include_sql: true })).toBe(false);
  });
  it("neither enabled is rejected", () => {
    expect(isDualOutputDisabled({ include_ast: false, include_sql: false })).toBe(true);
  });
});

describe("writer isolation", () => {
  it("AST writer does not accept SQL", () => {
    const parsed = AstWriterSchema.safeParse({
      kind: "success",
      ast: VALID_AST,
      message: null,
      reasonCode: null,
      tablesUsed: ["TEST_SET"],
      warnings: [],
      sql: "SELECT 1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as Record<string, unknown>).sql).toBeUndefined();
  });
  it("SQL writer does not accept AST", () => {
    const parsed = SqlWriterSchema.safeParse({
      kind: "success",
      sql: VALID_SQL,
      message: null,
      reasonCode: null,
      tablesUsed: ["TEST_SET"],
      warnings: [],
      ast: VALID_AST,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as Record<string, unknown>).ast).toBeUndefined();
  });
  it("SQL writer success requires non-empty raw SQL", () => {
    expect(
      SqlWriterSchema.safeParse({ kind: "success", sql: null, message: null, reasonCode: null, tablesUsed: [], warnings: [] }).success
    ).toBe(false);
    expect(
      SqlWriterSchema.safeParse({ kind: "unsupported", sql: null, message: "no", reasonCode: "X", tablesUsed: [], warnings: [] }).success
    ).toBe(true);
  });
  it("AST writer success rejects hallucinated from/fields shapes", () => {
    const bad = {
      kind: "success",
      ast: { version: "2.0", projection: { distinct: true }, from: { table: "TEST_SET" }, fields: [] },
      message: null,
      reasonCode: null,
      tablesUsed: [],
      warnings: [],
    };
    expect(AstWriterSchema.safeParse(bad).success).toBe(false);
    const ok = {
      kind: "success",
      ast: VALID_AST,
      message: null,
      reasonCode: null,
      tablesUsed: ["TEST_SET"],
      warnings: [],
    };
    expect(AstWriterSchema.safeParse(ok).success).toBe(true);
  });
});

describe("domain registry", () => {
  it("pinned projection cannot be overridden", () => {
    const ast = { ...VALID_AST, projection: { field: { kind: "field", alias: "ts", field: "TEST_SET_NAME" }, distinct: true, output: "PARENT_UUID" } };
    expect(validateDomainAst(ast as never, { domain: "all_test_sets" }).length).toBeGreaterThan(0);
    expect(validateDomainAst(VALID_AST as never, { domain: "all_test_sets" })).toEqual([]);
  });
  it("generic domain rejects unknown fields", () => {
    const bad = { ...VALID_AST, projection: { field: { kind: "field", alias: "zz", field: "NOPE" }, distinct: true, output: "PARENT_UUID" } };
    const shape = validateAstShape(bad);
    expect(shape.ast).not.toBeNull();
    if (shape.ast) expect(validateAstCatalogCheck(shape.ast, DEFAULT_SNAPSHOT).length).toBeGreaterThan(0);
  });
  it("illegal joins fail validation", () => {
    const bad = { ...VALID_AST, joins: [{ type: "INNER", entity: "NOPE", alias: "zz", on: [{ left: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, right: { kind: "field", alias: "zz", field: "X" } }] }] };
    const shape = validateAstShape(bad);
    if (shape.ast) expect(validateAstCatalogCheck(shape.ast, DEFAULT_SNAPSHOT).length).toBeGreaterThan(0);
    else expect(shape.issues.length).toBeGreaterThan(0);
  });
  it("business rules apply only when selected", () => {
    const withStatus = {
      ...VALID_AST,
      where: { kind: "comparison", left: { kind: "field", alias: "tc", field: "TEST_CASE_STATUS" }, operator: "EQ", right: { type: "string", value: "COMMITTED" } },
      joins: [{ type: "INNER", entity: "TEST_CASE", alias: "tc", on: [{ left: { kind: "field", alias: "ts", field: "TEST_SET_UUID" }, right: { kind: "field", alias: "tc", field: "TEST_SET_UUID" } }] }],
    };
    const shape = validateAstShape(withStatus);
    expect(shape.ast).not.toBeNull();
    if (shape.ast) {
      expect(validateBusinessRules(shape.ast, [], DEFAULT_SNAPSHOT).join(" ")).toMatch(/UNDECLARED_STATUS_FILTER/);
      expect(validateBusinessRules(shape.ast, ["RULE_ACTIVE_TEST_CASES"], DEFAULT_SNAPSHOT)).toEqual([]);
    }
  });
  it("SQL domain contract enforces pinned projection", () => {
    expect(validateSqlDomainContract("SELECT ts.TEST_SET_NAME FROM TEST_SET ts", "all_test_sets", DEFAULT_SNAPSHOT).length).toBeGreaterThan(0);
    expect(validateSqlDomainContract(VALID_SQL, "all_test_sets", DEFAULT_SNAPSHOT)).toEqual([]);
  });
});

describe("reconciliation", () => {
  it("SQL/AST disagreement is surfaced, never silent success", () => {
    const other = { ...VALID_AST, root: { entity: "TEST_CASE", alias: "tc" } };
    const shape = validateAstShape(other);
    expect(shape.ast).not.toBeNull();
    if (shape.ast) expect(compareSqlAndAstSemantics(VALID_SQL, shape.ast).length).toBeGreaterThan(0);
    expect(GENERATION_DISAGREEMENT).toBe("GENERATION_DISAGREEMENT");
  });
  it("unsupported and clarification carry null outputs + reasonCode", () => {
    const base = {
      sql: null, dbNeutralQuery: null, ast: null, dialect: "mysql", aiResponse: "x",
      filteringMetadata: null, warnings: [], error: null, unresolved: [],
      telemetry: {}, meta: {},
    };
    const u = composeResponse({ ...base, kind: "unsupported", reasonCode: "UNSUPPORTED_OPERATION", domain: "default", intent: "query", complexity: "simple", tablesUsed: [], stages: {}, triggers: [], retryCounts: {}, traceId: "t", latencyMs: 1, configSnapshotRef: "file-v1", modelsLive: true });
    expect(u.ast).toBeNull();
    expect(validateEnvelope(u, "unsupported").filter((i) => i.path === "reasonCode")).toEqual([]);
  });
  it("relative dates retain explicit unit and operator", () => {
    const ast = {
      ...VALID_AST,
      where: { kind: "relativeDate", field: { kind: "field", alias: "ts", field: "AE_INSERT_TS" }, operator: "IN_LAST", amount: 30, unit: "DAY" },
    };
    expect(QueryAstV2Schema.safeParse(ast).success).toBe(true);
  });
  it("prompt versions and domain/catalog versions are recorded", () => {
    const v = getPromptVersions("all_test_sets");
    expect(v).toMatchObject({ coordinator: "2.0", planner: "2.0", sqlWriter: "1.0", astWriter: "1.0", catalog: "file-v1" });
    expect(v.domain).toBe("all_test_sets@1.0");
    expect(getDomainDefinition("all_test_sets")?.requiredProjection?.field).toBe("TEST_SET_UUID");
    const env = composeResponse({
      kind: "success", dialect: "mysql", certifiedSql: null, dbNeutralQuery: null, ast: VALID_AST,
      cert: null, conversationalResponse: null, blockedMessage: null, error: null,
      warnings: [], unresolved: [], filteringMetadata: null, domain: "all_test_sets",
      intent: "list", complexity: "simple", tablesUsed: ["TEST_SET"], stages: {}, triggers: [],
      retryCounts: {}, traceId: "t", latencyMs: 1, configSnapshotRef: "file-v1",
      modelsLive: true, promptVersions: v,
    });
    expect(env.telemetry.promptVersions?.coordinator).toBe("2.0");
  });
});

const GOOD_PLAN = {
  kind: "data_query",
  canonicalQuery: "show test sets having more than five test cases",
  intent: "filtering",
  domain: "all_test_sets",
  relevantEntities: ["TEST_SET", "TEST_CASE"],
  selectedFields: [{ entity: "TEST_SET", field: "TEST_SET_UUID" }],
  legalJoinPaths: [],
  appliedRuleIds: ["RULE_ACTIVE_TEST_CASES"],
  searchScope: [],
  aggregation: null,
  order: [],
  limit: null,
  dateInterpretation: null,
  requiredProjection: null,
  ambiguity: [],
  unsupportedReason: null,
};

const PLAN_CTX = {
  question: "show test sets having more than five test cases",
  domainHint: "all_test_sets",
  requiredProjection: { field: "TEST_SET_UUID", output: "PARENT_UUID", distinct: true },
  snapshot: DEFAULT_SNAPSHOT,
};

describe("code-validated planning (application boundary)", () => {
  it("drops status rules the question never triggers", () => {
    const { kept, dropped } = filterRulesByQuestion(PLAN_CTX.question, ["RULE_ACTIVE_TEST_CASES"], DEFAULT_SNAPSHOT);
    expect(kept).toEqual([]);
    expect(dropped).toEqual(["RULE_ACTIVE_TEST_CASES"]);
    const triggered = filterRulesByQuestion("show my active test sets", ["RULE_ACTIVE_TEST_CASES"], DEFAULT_SNAPSHOT);
    expect(triggered.kept).toEqual(["RULE_ACTIVE_TEST_CASES"]);
  });
  it("validatePlan enforces projection, intent, fields, and domain fallback", () => {
    const r = validatePlan(GOOD_PLAN, PLAN_CTX);
    expect("plan" in r).toBe(true);
    if ("plan" in r) {
      expect(r.plan.appliedRuleIds).toEqual([]);
      expect(r.plan.intent).toBe("aggregation");
      expect(r.plan.requiredProjection?.field).toBe("TEST_SET_UUID");
      expect(r.plan.selectedFields).toEqual([{ entity: "TEST_SET", field: "TEST_SET_UUID" }]);
      expect(r.plan.warnings.length).toBeGreaterThan(0);
    }
    const badDomain = validatePlan({ ...GOOD_PLAN, domain: "test-management" }, PLAN_CTX);
    expect("plan" in badDomain && badDomain.plan.domain).toBe("all_test_sets");
    const badField = validatePlan(
      { ...GOOD_PLAN, selectedFields: [{ entity: "TEST_SET", field: "id" }] },
      PLAN_CTX
    );
    expect("plan" in badField && badField.plan.selectedFields).toEqual([]);
    const greeting = validatePlan({ ...GOOD_PLAN, kind: "greeting" }, PLAN_CTX);
    expect("plan" in greeting && greeting.plan.kind).toBe("greeting");
  });
  it("contracts are code-built JSON with real arrays", () => {
    const r = validatePlan(GOOD_PLAN, PLAN_CTX);
    expect("plan" in r).toBe(true);
    if ("plan" in r) {
      const sql = JSON.parse(buildSqlContract(r.plan, "mysql", "none"));
      expect(sql.rules).toEqual([]);
      expect(sql.t).toEqual(["TEST_SET", "TEST_CASE"]);
      const ast = JSON.parse(buildAstContract(r.plan, "none"));
      expect(ast.requiredProjection?.field).toBe("TEST_SET_UUID");
    }
  });
  it("extractBranchJson prefers structured output, falls back to fenced text", () => {
    const viaStructured = extractBranchJson(
      { structuredResponse: { kind: "success", sql: "SELECT 1", tablesUsed: [] } },
      ["kind", "sql", "tablesUsed"]
    );
    expect(viaStructured?.sql).toBe("SELECT 1");
    const viaText = extractBranchJson(
      { messages: [{ content: 'done\n```json\n{"kind":"success","sql":"SELECT 1","tablesUsed":[]}\n```' }] },
      ["kind", "sql", "tablesUsed"]
    );
    expect(viaText?.sql).toBe("SELECT 1");
    expect(extractBranchJson({ messages: [{ content: "thinking" }] }, ["kind", "sql", "tablesUsed"])).toBeNull();
  });
});
