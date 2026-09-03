# Business Rules for `all_test_sets`

### `RULE_ACTIVE_TEST_CASES`
- **Target**: `TEST_CASE.TEST_CASE_STATUS`
- **SQL Condition**: `tc.TEST_CASE_STATUS = 'COMMITTED'`
- **Trigger**: Select ONLY when the user explicitly asks for active, committed, or published test cases. Never select by default.

### `RULE_DRAFT_TEST_CASES`
- **Target**: `TEST_CASE.TEST_CASE_STATUS`
- **SQL Condition**: `tc.TEST_CASE_STATUS = 'DRAFT'`
- **Trigger**: Select ONLY when the user explicitly asks for draft, uncommitted, or work-in-progress test cases. Never select by default.

### `RULE_EXCLUDE_COMMENTED_STEPS` (Default Rule)
- **Target**: `TEST_CASE_STEP.IS_COMMENTED_STEP`
- **SQL Condition**: `(tcs.IS_COMMENTED_STEP != 'Yes' OR tcs.IS_COMMENTED_STEP IS NULL)`
- **Trigger**: Applies automatically whenever test case steps are queried, unless the user explicitly asks to include commented steps.

### `RULE_ORPHAN_TEST_SETS`
- **Target**: `TEST_SET`
- **SQL Condition**: `ts.TEST_SET_TYPE IN ('User Action', 'API') AND ts.API_UUID IS NULL AND ts.USER_ACTION_UUID IS NULL`
- **Trigger**: Select when user asks for orphan, unlinked, or standalone test suites.

### `RULE_PERSONAL_TEST_SETS`
- **Target**: `TEST_SET.TEST_SET_TYPE`
- **SQL Condition**: `ts.TEST_SET_TYPE = 'Personal'`
- **Trigger**: Select when user specifically asks for personal test sets.
