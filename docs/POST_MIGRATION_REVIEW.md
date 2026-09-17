# Post-change codebase review

## Current status

The dual-writer migration is implemented on this branch per `FINAL_IMPLEMENTATION_PROMPT.md`.
SQL and AST are generated independently by `sql-writer` and `ast-writer`
subagents from the same planner contract. `sqlToAstV2()` is no longer on the
production path.

## What changed

- `planner` emits compact `QueryPlan` v2.0 (no free-form reasoning).
- `sql-writer` (`sql-writer.prompt.md` + `SqlWriterSchema`) emits SQL only.
- `ast-writer` (`ast-writer.prompt.md` + `AstWriterSchema`) emits strict AST v2 only.
- `coordinator.ts` validates each branch independently, reconciles semantics
  via `compareSqlAndAstSemantics()`, and returns typed
  `GENERATION_DISAGREEMENT` instead of silently picking one artifact.
- `include_sql=false + include_ast=false` is rejected with 400 at the API
  boundary and fail-closed in the coordinator.
- Pinned `all_test_sets` projection is enforced in code
  (`validateDomainAst` + `validateSqlDomainContract`), never prompt-only.
- Prompt/domain/catalog versions ride in `telemetry.promptVersions`.
- Frontend sends both flags (default on), exposes SQL/AST toggles, hides
  null-output panels, renders unsupported/clarification/disagreement states,
  never executes when SQL is null, and keeps AST inspection independent.
- OpenAPI documents both flags; `deep-smoke` expects 3 subagents.

## Remaining follow-ups (non-blocking)

- LLM branch repair is prompt-ready (`sql-repair`, `ast-repair`) but the
  runtime currently counts deterministic structural repair as the single
  allowed repair. Wire a second agent invocation per failing branch if live
  repair quality needs it.
- `writer.prompt.md` / `WriterSchema` / `sqlToAstV2()` remain for migration
  reference and offline tests. Remove them once no caller depends on the
  SQL-first path.
- Browser vs App Engine trust boundary (auth/gateway rejecting
  browser-supplied domain/projection/dialect/time) is still TODO in `server.ts`.

## Release recommendation

Safe to merge after `npm run typecheck`, `npm test`,
`npm run prompts:check`, frontend `build`/`lint`, and the dual-writer test
matrix (`tests/unit/domain/dual-writer.test.ts`) all pass.
