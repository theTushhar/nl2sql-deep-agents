# Prompt for Completing the Query AI AST/SQL Dual-Writer Migration

You are working in the `theTushhar/nl2sql-deep-agents` repository. Complete the migration to a Deep Agents based dual-output Query AI service. Do not preserve the old SQL-first behavior. Breaking changes are explicitly allowed. Remove obsolete code, prompts, comments, schemas, tests, and documentation rather than retaining compatibility shims.

## Product requirements

InfoQA consumes this service for multiple UI screen domains.

- A pinned domain such as `all_test_sets` represents a specific UI screen.
- A pinned domain supplies trusted allowed entities, rules, join paths, and a required parent UUID projection.
- The generic domain lets the AI reason over the catalog and select the best entities, fields, joins, and rules.
- Query AI must return AST v2 and/or SQL depending on request flags.
- SQL and AST must be generated independently by Deep Agent subagents.
- Never parse SQL into AST and never generate SQL from AST inside Query AI.
- App Engine may compile AST to a target database, but Query AI may also return a separately generated SQL artifact.

## Request contract

Implement these canonical request fields:

```ts
query: string;                 // max 500
 domain?: string;              // trusted App Engine field
 dialect?: "mysql" | "mssql";
 ast_version?: "2.0";
 required_projection?: RequiredProjection;
 time_context?: TimeContext;
 include_ast?: boolean;        // default true
 include_sql?: boolean;        // default true
 include_traces?: boolean;     // default false
 request_id?: string;
 thread_id?: string;
 user_id?: string;
```

Reject requests where both `include_ast` and `include_sql` are false. Do not accept browser-originated domain, projection, dialect, or time context in the public browser API; distinguish internal App Engine requests from browser requests with authentication or a trusted gateway contract.

## Required response behavior

- `include_ast=true`: run AST Writer and return `data.ast`.
- `include_ast=false`: do not instantiate or invoke AST Writer; return `data.ast=null`.
- `include_sql=true`: run SQL Writer and return `data.sql`.
- `include_sql=false`: do not instantiate or invoke SQL Writer; return `data.sql=null`.
- Both enabled: run both writers independently and return both artifacts.
- Unsupported or ambiguous: return `ast:null`, `sql:null` for the unavailable/invalid output and the appropriate status.
- Never return a weakened, incomplete, constant-false, or invented AST.

## Target Deep Agents architecture

Use Deep Agents subagents and isolated execution state. Do not replace the system with a hand-written LangGraph workflow.

```text
Deep Agent coordinator
  -> planner subagent exactly once
  -> independent SQL Writer subagent if include_sql
  -> independent AST Writer subagent if include_ast
  -> deterministic validators
  -> optional branch-specific repair, max one per branch
  -> reconciliation if both outputs exist
  -> deterministic response composer
```

The SQL and AST writers must receive the same immutable planner result and compact catalog context. They must not receive each other’s output. Use isolated checkpoint/thread IDs:

```text
<requestId>:planner
<requestId>:sql-writer
<requestId>:ast-writer
<requestId>:sql-repair
<requestId>:ast-repair
```

If the Deep Agents coordinator cannot safely issue concurrent task calls in one graph state, execute two independent Deep Agent invocations concurrently at the application boundary with `Promise.all`. Do not mutate one shared checkpoint from parallel writers.

## Planner output

Replace the current planner output with a compact typed plan:

```ts
interface QueryPlan {
  kind: "data_query" | "greeting" | "out_of_scope" | "malicious";
  canonicalQuery: string;
  intent: "filtering" | "aggregation" | "list";
  domain: string;
  relevantEntities: string[];
  selectedFields: Array<{ entity: string; field: string }>;
  legalJoinPaths: JoinPath[];
  appliedRuleIds: string[];
  searchScope: string[];
  aggregation?: AggregationPlan;
  order?: OrderPlan[];
  limit?: number;
  dateInterpretation?: DatePlan;
  requiredProjection?: RequiredProjection;
  ambiguity: string[];
  unsupportedReason: string | null;
}
```

Remove free-form planner `reasoning` from production output. If debugging requires it, make it opt-in and bounded.

## AST Writer

Create `ast-writer.prompt.md` and `AstWriterSchema`. It must emit only:

```ts
{
  kind: "success" | "unsupported" | "clarification_required";
  ast: QueryAstV2 | null;
  message: string | null;
  reasonCode: string | null;
  tablesUsed: string[];
  warnings: string[];
}
```

Use the supplied strict `QueryAstV2Schema`. Reject unknown keys. AST Writer must never emit SQL or SQL fragments.

## SQL Writer

Create a dedicated SQL Writer prompt and schema. It must emit:

```ts
{
  kind: "success" | "unsupported" | "clarification_required";
  sql: string | null;
  message: string | null;
  reasonCode: string | null;
  tablesUsed: string[];
  warnings: string[];
}
```

SQL Writer must use the planner contract verbatim. It must not re-plan, invent fields, invent joins, or infer undeclared status rules.

## Domain registry

Replace ad hoc domain branches with declarative domain definitions:

```ts
interface DomainDefinition {
  name: string;
  description: string;
  allowedEntities: string[];
  allowedJoinPaths: JoinPath[];
  requiredProjection?: RequiredProjection;
  rules: DomainRule[];
  skills: string[];
  capabilities: string[];
}
```

Separate rules into:

1. Mandatory projection rules.
2. Structural entity/field/join rules.
3. Business-language-to-predicate rules.
4. Default safety rules.

For `all_test_sets`, enforce `TEST_SET_UUID`, `distinct:true`, and `output:"PARENT_UUID"` in code after AST generation. Do not rely only on prompt instructions.

For `default`, allow progressive catalog reasoning but reject unknown entities, fields, aliases, and joins.

## Validators

Implement independent validators:

- `validateAstShape()`
- `validateAstCatalog()`
- `validateAstLimits()`
- `validateDomainAst()`
- `validateBusinessRules()`
- `validateSql()`
- `validateSqlDomainContract()`
- `compareSqlAndAstSemantics()`

Validation must fail closed. Do not silently add missing filters, drop filters, alter projections, or convert ambiguity into success.

## Reconciliation

When both outputs are requested:

1. Validate both independently.
2. Compare root entity, projection, tables, joins, predicates, aggregation, grouping, HAVING, order, limit, and date semantics.
3. If semantically aligned, return both.
4. If one branch fails, perform one repair only for that branch.
5. If they still disagree, return a typed `GENERATION_DISAGREEMENT` error or clarification. Never select one silently.

## Prompt management

Use these prompt files:

```text
prompts/coordinator.prompt.md
prompts/planner.prompt.md
prompts/sql-writer.prompt.md
prompts/ast-writer.prompt.md
prompts/sql-repair.prompt.md
prompts/ast-repair.prompt.md
prompts/reconciliation.prompt.md
prompts/_safety.md
```

Keep prompts short and responsibility-specific. Do not duplicate schema text, business rules, or safety rules across prompts. Put catalog facts in compact tool results. Load only the skill for the selected domain.

Add prompt metadata to telemetry:

```ts
{
  coordinator: "2.0",
  planner: "2.0",
  sqlWriter: "1.0",
  astWriter: "1.0",
  domain: "all_test_sets@1.0",
  catalog: "file-v1"
}
```

## Remove obsolete implementation

Delete or stop using:

- SQL-to-AST conversion as a production path.
- `sqlToAstV2()` fallback generation.
- Writer fields that contain AST.
- Coordinator instructions claiming AST is always built from SQL.
- Checker prompt/subagent if deterministic validators replace it.
- Legacy aliases that are not part of the final contract.
- Dead SQL-first comments and tests.

## Frontend changes

Update frontend types, request builder, telemetry, and UI:

- Add output controls for SQL and AST.
- Default both to enabled.
- Send `include_sql` and `include_ast`.
- Hide SQL panels when SQL is null.
- Hide AST panels when AST is null.
- Display unsupported, clarification, and generation-disagreement states.
- Do not attempt SQL execution when SQL is unavailable.
- Keep AST inspection available independently of SQL.
- Ensure custom payload mode can override both flags.

## Tests

Add tests for:

1. AST only: AST Writer runs, SQL Writer does not.
2. SQL only: SQL Writer runs, AST Writer does not.
3. Both: both run independently.
4. Neither: request rejected.
5. AST writer cannot emit SQL.
6. SQL writer cannot emit AST.
7. Domain projection cannot be overridden.
8. Generic domain rejects unknown fields.
9. Illegal joins fail validation.
10. Business rules are applied only when selected.
11. SQL/AST semantic disagreement is not returned as success.
12. Unsupported and clarification responses contain null outputs.
13. Relative dates retain time zone and anchor semantics.
14. Prompt versions and domain/catalog versions are recorded.

Run:

```bash
cd backend
npm ci
npm run typecheck
npm test
npm run prompts:check

cd ../frontend
npm ci
npm run build
npm run lint
```

Fix all compile and test failures. Then update README, OpenAPI, `.env.example`, knowledge base, and performance documentation to match the new implementation.
