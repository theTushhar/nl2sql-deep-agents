# Post-change codebase review

## Current status

The repository now contains the requested dual-writer contracts and prompt direction, but the runtime is still mid-migration.

## Remaining implementation gaps

- `coordinator.ts` still treats SQL as mandatory in the success path.
- `sqlToAstV2()` remains on the production AST path and must be removed after AST Writer is wired.
- `include_sql` is accepted and propagated but does not yet fully suppress SQL generation.
- `include_ast` is accepted, but the existing coordinator still contains SQL-derived AST assumptions.
- SQL and AST branches are not yet independently reconciled.
- The frontend has request fields but does not yet expose complete output toggles and null-output states throughout every UI path.
- OpenAPI is not fully synchronized with the dual-writer response contract.
- Domain metadata is still primarily embedded in the static config rather than a complete versioned domain registry.
- Prompt version metadata is not yet included in telemetry.
- Dependencies are not installed in the checkout, so typecheck/build/test execution remains pending.

## Positive changes

- AST Writer has a dedicated schema and prompt.
- Coordinator instructions prohibit SQL-to-AST and AST-to-SQL coupling.
- Output flags are present in backend and frontend request types.
- Planner, SQL Writer, and AST Writer have separate responsibilities and budgets.
- Domain and performance documentation exists.

## Release recommendation

Do not open the production PR until the final implementation prompt in `FINAL_IMPLEMENTATION_PROMPT.md` has been executed, the SQL-first coordinator path has been removed, and the complete test matrix passes. The prompt is intentionally detailed enough to hand to another coding agent for completion.
