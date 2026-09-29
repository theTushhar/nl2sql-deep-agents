---
name: default-reporting
description: Builds flexible multi-column analytical SELECT queries (counts, groupings, orderings, ad-hoc reporting) for the default domain. Use when the question asks for metrics, breakdowns, rankings, or any data report that is NOT a single-UUID UI grid filter. Do NOT use for all_test_sets grid filtering — that belongs to the all-test-sets skill.
---

# Default Reporting Skill

## Overview

This skill guides open-ended analytical reporting over the InfoQA Test Management schema (`TEST_SET`, `TEST_CASE`, `TEST_CASE_STEP`). Unlike grid-filter domains with a fixed single-column projection, the `default` domain honors the question intent: any explicit columns, aggregates, groupings, or orderings the question asks for.

## When to Use

- The planner resolved domain `default` (general analytical / multi-column reporting).
- The question asks "how many", "count", "group by", "top N", "latest", "average", or requests specific columns (names, dates, statuses, IDs).
- Do NOT use for `all_test_sets` UI grid filtering (single `TEST_SET_UUID` subqueries).

## Instructions

### 1. Projection (flexible, question-driven)

- Project exactly the columns the question asks for — names, dates, statuses, keys — plus primary keys (`TEST_SET_UUID`, `TEST_CASE_UUID`, `TEST_CASE_STEP_UUID`) alongside descriptive columns so rows stay identifiable.
- NEVER use `SELECT *` or `alias.*`. Enumerate every column explicitly.
- Aggregations: use `COUNT(DISTINCT <key>) AS <alias>` for counts (e.g. `COUNT(DISTINCT tc.TEST_CASE_UUID) AS case_count`). Do NOT project row UUIDs when answering a pure aggregate unless grouping by them.
- `DISTINCT` only when the question implies deduplication; it is not a default here.

### 2. Grouping, Ordering, Limit

- `GROUP BY` every non-aggregated projected column (or its entity key) when aggregates are present.
- `HAVING` filters on aggregates (e.g. `HAVING COUNT(*) > 5`); `WHERE` filters on rows.
- `ORDER BY` is required whenever the question implies ranking ("top", "latest", "first") or a `LIMIT` is used. `LIMIT` only when the question requests a count cap (1–1000).

### 3. Status Columns

- `tc.TEST_CASE_STATUS` is the lifecycle state (`COMMITTED` / `DRAFT`); `tc.LATEST_RUN_STATUS` is the execution outcome (`PASSED` / `FAILED`). When the question says "status", check which one it means — prefer both only when genuinely ambiguous.
- Equality comparisons (`=`, `IN`, `IS NULL`) are legal on ANY column; `LIKE`/`REGEXP` only on `searchable: true` columns, case-insensitive via `LOWER(column) LIKE` with lowercase terms.

### 4. Joins and Steps

- Join only tables the filters or projection need, along the schema relationships (`TEST_SET ts` → `TEST_CASE tc` → `TEST_CASE_STEP tcs`).
- Step queries: include `tcs.TEST_CASE_STEP_SEQ_ID` and sort `ORDER BY tcs.TEST_CASE_STEP_SEQ_ID ASC`; exclude commented steps by default (`tcs.IS_COMMENTED_STEP != 'Yes' OR tcs.IS_COMMENTED_STEP IS NULL`) unless asked otherwise.

### 5. Date and Timestamp Filtering

- Use `AE_INSERT_TS` for creation filters, `AE_UPDATE_TS` for modification filters.
- Resolve relative dates once into fixed UTC ISO bounds using the `time_context` from the task description (e.g. `ts.AE_INSERT_TS >= '2026-09-18T10:00:00Z'`). Never emit non-deterministic functions (`NOW()`, `CURDATE()`, `DATE_SUB()`).
