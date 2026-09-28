---
name: all-test-sets
description: Generates UI grid filtering subqueries targeting the All Test Set grid. Always projects ONLY `SELECT DISTINCT ts.TEST_SET_UUID`.
---

# All Test Sets Subquery Generation Skill

## Core Projection Invariant
- The caller UI uses this subquery to filter records: `WHERE ts.TEST_SET_UUID IN (<generated_subquery>)`.
- Therefore, the subquery MUST project **strictly one column**: `SELECT DISTINCT <alias>.TEST_SET_UUID`.
- DO NOT project any other columns (e.g. no names, dates, counts, or case UUIDs in outer SELECT).
- NEVER alias a non-UUID column as TEST_SET_UUID.
- This holds for aggregations too: if the question asks for a count within this domain, express the filter first (single-UUID subquery shape); multi-column reporting belongs to the `default` domain, not here.
- Numeric IDs (e.g. `TEST_CASE_ID 8735`) are filters in WHERE, never projections in place of the UUID.

## Table Hierarchy & Joins
- **Root Table**: `TEST_SET ts`
- **Cases Table**: `TEST_CASE tc` via `ts.TEST_SET_UUID = tc.TEST_SET_UUID`
- **Steps Table**: `TEST_CASE_STEP tcs` via `tc.TEST_CASE_UUID = tcs.TEST_CASE_UUID`

## Business Rules
1. **Commented Steps**: By default, always exclude commented steps:
   `(tcs.IS_COMMENTED_STEP != 'Yes' OR tcs.IS_COMMENTED_STEP IS NULL)`
2. **Active Cases**: "Active" test cases strictly map to:
   `tc.TEST_CASE_STATUS = 'COMMITTED'`
3. **Keyword & Text Searches**:
   - **Case Insensitivity**: Always wrap column comparisons with `LOWER(col) LIKE 'term%'` (for prefix / starts with) or `LOWER(col) LIKE '%term%'` (for contains / includes) using lowercase search terms.
   - **Delimiter Invariance**: For keyword searches with spaces or multi-word terms (e.g. "global sqa"), expand across common naming conventions (spaced, snake_case, collapsed/camelCase) using `OR`:
     `(LOWER(ts.TEST_SET_NAME) LIKE '%global sqa%' OR LOWER(ts.TEST_SET_NAME) LIKE '%global_sqa%' OR LOWER(ts.TEST_SET_NAME) LIKE '%globalsqa%')`
     This ensures matching whether names are stored as "Global SQA", "global_sqa", or "GlobalSQA".
4. **Empty Match**: If the question asks for metadata or summaries that cannot be rendered as a test set UUID filter, output:
   `SELECT ts.TEST_SET_UUID FROM TEST_SET ts WHERE 1=0`
