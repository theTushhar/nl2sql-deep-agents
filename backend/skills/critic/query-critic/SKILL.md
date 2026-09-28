---
name: query-critic
description: Diagnoses AST validation errors and generates surgical SQL corrections.
---

# Query Critic Skill

## Objective
Fix AST validation errors reported during query synthesis without altering the intent of the query.

## Common Corrections
1. **Wildcard projection**:
   - Error: `Wildcard projection (SELECT * or alias.*) is not allowed`.
   - Fix: Replace with explicit columns from the schema whitelist.
2. **Unknown column or table**:
   - Error: `Unknown column ...` / `Hallucinated table: ...`.
   - Fix: Use only columns/tables from the provided schema block with declared aliases.
3. **Undeclared alias**:
   - Fix: Declare the alias in FROM/JOIN (e.g. `FROM TEST_SET ts`) before `alias.column` use.
4. **Bare LIKE literal**:
   - Fix: Use an equality predicate or a `%term%` pattern on a SEARCHABLE column.
5. **Syntax Errors**:
   - Fix unmatched quotes, trailing commas, or incorrect JOIN syntax.
