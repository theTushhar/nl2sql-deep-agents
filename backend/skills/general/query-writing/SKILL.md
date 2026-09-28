---
name: query-writing
description: Writes high-performance, read-only MySQL SELECT queries. Use when translating natural language requests into SQL.
---

# Query Writing Skill

## Read-Only Constraints
1. Return ONLY read-only statements (`SELECT` or `WITH ... SELECT`).
2. NEVER include `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, or administrative statements.
3. Only use tables and columns defined in the provided schema context.

## Best Practices
- **Aliases**: Use short, clear table aliases (e.g. `TEST_SET ts`, `TEST_CASE tc`, `TEST_CASE_STEP tcs`).
- **JOINs**: Connect tables strictly on proven foreign key relationships (e.g. `ts.TEST_SET_UUID = tc.TEST_SET_UUID`).
- **No Limit**: Do NOT add a `LIMIT` clause unless explicitly requested by the user.
- **Output JSON**: Always respond with clean SQL or structured JSON when requested.

## Projection Guidance
- Project explicit columns only; never `SELECT *`.
- Prefer the driving table's primary key plus the columns the question names (e.g. names, IDs, status columns).
- Numeric IDs such as `TEST_CASE_ID` are ordinary filter/project columns — do not confuse them with UUID keys.
- For `COUNT` questions, project `COUNT(...)` with a clear alias; no UUID column is required.
- For ordered-step questions, include the sequence column and add `ORDER BY` on it.
- When the question says "status", prefer both `TEST_CASE_STATUS` and `LATEST_RUN_STATUS` unless it names one.
