---
name: all-test-sets
description: Generates UI grid filtering subqueries targeting the All Test Sets grid. Always projects ONLY `SELECT DISTINCT ts.TEST_SET_UUID`. Use when the user wants to search, browse, filter, or list test sets, test cases, or test steps in the UI grid.
---

# All Test Sets Subquery Generation Skill

## Overview
This skill guides the synthesis of read-only MySQL subqueries specifically designed to filter records in the InfoQA All Test Sets grid. The calling frontend UI embeds the generated SQL directly into a filter clause:
```sql
WHERE ts.TEST_SET_UUID IN (<generated_subquery>)
```
Because the UI expects a set of test suite UUIDs to filter the grid, every query in this domain must adhere strictly to the single-column UUID projection contract.

## When to Use
- The user query domain is `all_test_sets` (or specified via domain hint).
- The user asks to find, list, search, or filter test sets, test cases, or execution steps.
- The request describes test suite properties (e.g., "Personal test sets", "Suites containing active test cases", "Test sets with step name containing 'login'").
- Do NOT use this skill for multi-column analytical reporting (e.g., "Count of cases grouped by status"); multi-column reports belong to the `default` domain.

## Instructions

### 1. Core Projection Invariant
- **Single Column Rule**: The subquery MUST project **strictly one column**:
  ```sql
  SELECT DISTINCT ts.TEST_SET_UUID
  ```
- **No Non-UUID Projections**: Never project names, dates, counts, or case UUIDs in the outer `SELECT`.
- **No UUID Aliasing**: Never alias a non-UUID column (e.g., `TEST_CASE_ID`) as `TEST_SET_UUID`.
- **Numeric IDs**: Numeric identifiers (such as `TEST_CASE_ID 8735` or `TEST_SET_ID 102`) must be used as filters in the `WHERE` clause, never in the `SELECT` projection.
- **Aggregations & HAVING**: When filtering test sets by aggregated metrics (e.g. "having more than 5 test cases"), group by `ts.TEST_SET_UUID` and filter using `HAVING COUNT(...) > 5`. You MUST keep `SELECT DISTINCT ts.TEST_SET_UUID` in the projection; NEVER remove `DISTINCT`.
  Example:
  ```sql
  SELECT DISTINCT ts.TEST_SET_UUID
  FROM TEST_SET ts
  JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID
  WHERE tc.TEST_CASE_STATUS = 'COMMITTED'
  GROUP BY ts.TEST_SET_UUID
  HAVING COUNT(tc.TEST_CASE_UUID) > 5;
  ```
- **Empty Filter Fallback**: If the user request asks for metadata or summaries that cannot be rendered as a test set filter, return:
  ```sql
  SELECT ts.TEST_SET_UUID FROM TEST_SET ts WHERE 1=0
  ```

### 2. Table Hierarchy and Joins
Always join tables strictly along proven foreign key relationships:
- **Root Table**: `TEST_SET ts` (Primary Key: `TEST_SET_UUID`)
- **Test Cases Table**: `TEST_CASE tc` (Foreign Key: `tc.TEST_SET_UUID = ts.TEST_SET_UUID`)
- **Test Steps Table**: `TEST_CASE_STEP tcs` (Foreign Key: `tcs.TEST_CASE_UUID = tc.TEST_CASE_UUID`)

Standard join path:
```sql
SELECT DISTINCT ts.TEST_SET_UUID
FROM TEST_SET ts
JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID
JOIN TEST_CASE_STEP tcs ON tc.TEST_CASE_UUID = tcs.TEST_CASE_UUID
WHERE ...
```
Only join `TEST_CASE` or `TEST_CASE_STEP` when the query conditions require columns from those tables. If filtering only on `TEST_SET` columns, do not join downstream tables.

### 3. Business Rules and Status Invariants
Apply the following standard business rules:
- **Active Test Cases**: Active, committed, or published test cases always map to:
  ```sql
  tc.TEST_CASE_STATUS = 'COMMITTED'
  ```
- **Draft Test Cases**: Draft, uncommitted, or in-progress test cases map to:
  ```sql
  tc.TEST_CASE_STATUS = 'DRAFT'
  ```
- **Commented Steps**: By default, always exclude commented execution steps whenever step data is queried:
  ```sql
  (tcs.IS_COMMENTED_STEP != 'Yes' OR tcs.IS_COMMENTED_STEP IS NULL)
  ```
- **Personal Test Sets**: Personal test suites map to:
  ```sql
  ts.TEST_SET_TYPE = 'Personal'
  ```
- **Orphan Test Sets**: Unlinked or standalone suites map to:
  ```sql
  ts.TEST_SET_TYPE IN ('User Action', 'API') AND ts.API_UUID IS NULL AND ts.USER_ACTION_UUID IS NULL
  ```

### 4. Text Search and Keyword Matching
- **Case Insensitivity**: Always use `LOWER(column) LIKE '%term%'` with lowercase search literals.
- **Searchable Columns Only**: Text searches are allowed ONLY on columns marked `searchable: true` in the schema (`ts.TEST_SET_NAME`, `ts.TEST_SET_TYPE`, `tc.TEST_CASE_NAME`, `tcs.TEST_CASE_STEP_NAME`).
- **Delimiter Invariance**: For user search phrases with spaces or compound names (e.g., "global sqa"), expand the condition across common naming conventions:
  ```sql
  (LOWER(ts.TEST_SET_NAME) LIKE '%global sqa%' OR LOWER(ts.TEST_SET_NAME) LIKE '%global_sqa%' OR LOWER(ts.TEST_SET_NAME) LIKE '%globalsqa%')
  ```

### 5. Date and Timestamp Filtering
- Use `AE_INSERT_TS` for creation date filters and `AE_UPDATE_TS` for update/modification date filters.
- Always resolve relative dates once into UTC bounds using the `time_context` supplied in the task description (never emit non-deterministic DB date functions like `NOW()`, `CURDATE()`, or `DATE_SUB()`):
  - Last 7 days / recent window: `ts.AE_INSERT_TS >= '<UTC_LOWER_BOUND>'` (e.g. `ts.AE_INSERT_TS >= '2026-09-18T10:00:00Z'`)
  - Specific date: `DATE(ts.AE_INSERT_TS) = 'YYYY-MM-DD'`
