# Table Schemas for `all_test_sets`

### Table: `TEST_SET` (alias: `ts`)
- **Description**: Test suite container. Groups multiple test cases together for execution.
- **Primary Key**: `TEST_SET_UUID`
- **Columns**:
  - `TEST_SET_UUID` (VARCHAR(36), PK, searchable: false)
  - `TEST_SET_ID` (INT, searchable: false)
  - `TEST_SET_NAME` (VARCHAR(255), searchable: true)
  - `TEST_SET_TYPE` (VARCHAR(100), searchable: true, allowed: ["Personal", "User Action", "UI Locator Verification", "API", "User Story", "Feature", "Sub Process"])
  - `PAGE_UUID` (VARCHAR(36), searchable: false)
  - `VIEW_UUID` (VARCHAR(36), searchable: false)
  - `FUNCTIONAL_AREA_UUID` (VARCHAR(36), searchable: false)
  - `TEST_SET_OWNER` (VARCHAR(36), searchable: false)
  - `AE_INSERT_TS` (DATETIME, searchable: false)
  - `AE_UPDATE_TS` (DATETIME, searchable: false)
- **Relationships**:
  - `TEST_SET ts JOIN TEST_CASE tc ON ts.TEST_SET_UUID = tc.TEST_SET_UUID` (1:N)
  - `TEST_SET ts JOIN TEST_CASE_STEP tcs ON ts.TEST_SET_UUID = tcs.TEST_SET_UUID` (1:N)

### Table: `TEST_CASE` (alias: `tc`)
- **Description**: Individual test cases belonging to a test set.
- **Primary Key**: `TEST_CASE_UUID`
- **Columns**:
  - `TEST_CASE_UUID` (VARCHAR(36), PK, searchable: false)
  - `TEST_SET_UUID` (VARCHAR(36), FK -> TEST_SET.TEST_SET_UUID, searchable: false)
  - `TEST_CASE_ID` (INT, searchable: false)
  - `TEST_CASE_NAME` (VARCHAR(500), searchable: true)
  - `TEST_CASE_SEQ_ID` (INT, searchable: false)
  - `TEST_CASE_STATUS` (VARCHAR(50), searchable: false)
  - `TEST_CASE_EXECUTON_TYPE` (VARCHAR(50), searchable: false)
  - `LATEST_RUN_STATUS` (VARCHAR(50), searchable: false)
  - `LATEST_RUN_UUID` (VARCHAR(36), searchable: false)
  - `AE_INSERT_TS` (DATETIME, searchable: false)
  - `AE_UPDATE_TS` (DATETIME, searchable: false)
- **Relationships**:
  - `TEST_CASE tc JOIN TEST_SET ts ON tc.TEST_SET_UUID = ts.TEST_SET_UUID` (N:1)
  - `TEST_CASE tc JOIN TEST_CASE_STEP tcs ON tc.TEST_CASE_UUID = tcs.TEST_CASE_UUID` (1:N)

### Table: `TEST_CASE_STEP` (alias: `tcs`)
- **Description**: Ordered execution steps within a test case.
- **Primary Key**: `TEST_CASE_STEP_UUID`
- **Columns**:
  - `TEST_CASE_STEP_UUID` (VARCHAR(36), PK, searchable: false)
  - `TEST_CASE_UUID` (VARCHAR(36), FK -> TEST_CASE.TEST_CASE_UUID, searchable: false)
  - `TEST_SET_UUID` (VARCHAR(36), FK -> TEST_SET.TEST_SET_UUID, searchable: false)
  - `TEST_CASE_STEP_ID` (INT, searchable: false)
  - `TEST_CASE_STEP_NAME` (VARCHAR(500), searchable: true)
  - `TEST_CASE_STEP_SEQ_ID` (INT, searchable: false)
  - `TEST_CASE_STEP_TYPE` (VARCHAR(50), searchable: false)
  - `IS_COMMENTED_STEP` (VARCHAR(10), searchable: false)
  - `STEP_DEF_UUID` (VARCHAR(36), searchable: false)
  - `AE_INSERT_TS` (DATETIME, searchable: false)
  - `AE_UPDATE_TS` (DATETIME, searchable: false)
- **Relationships**:
  - `TEST_CASE_STEP tcs JOIN TEST_CASE tc ON tcs.TEST_CASE_UUID = tc.TEST_CASE_UUID` (N:1)
  - `TEST_CASE_STEP tcs JOIN TEST_SET ts ON tcs.TEST_SET_UUID = ts.TEST_SET_UUID` (N:1)
