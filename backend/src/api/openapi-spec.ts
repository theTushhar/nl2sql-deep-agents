// OpenAPI spec for NlQuery_InfoQAAI backend (mirrors src/server.ts routes).
// Aligned to Query AI AST v2 contract (version 2.0, JSON only, no SQL
// fragments, no raw escape hatch).
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "NlQuery_InfoQAAI — Query AI AST v2 API",
    description: [
      "Stateless Natural Language to AST v2 synthesis (Query AI side of the App Engine contract).",
      "Send `query`; receive a strict AST v2 (`version 2.0`) plus certified SQL rendering and telemetry.",
      "",
      "Design requirements:",
      "- JSON only; no SQL fragments and no `raw` escape hatch.",
      "- Database-neutral operations compiled by App Engine for MySQL or MSSQL.",
      "- Exact, versioned, discriminated node types with unknown keys rejected.",
      "- Values remain values; tables and columns remain identifiers. They are never interchangeable.",
      "- Grid projection is locked by App Engine to the configured parent UUID.",
      "- Relative dates have explicit calendar semantics and are resolved using a supplied time zone and anchor time.",
      "- Aggregates and HAVING are first-class.",
      "- Unsupported requests produce an explicit unsupported/clarification response, never an incomplete AST.",
      "",
      "Trust boundary: the browser request must NOT supply `domain`, projection, dialect, or time context.",
      "App Engine derives them from trusted configuration and server time and sends the App Engine → Query AI",
      "request documented under POST /api/query.",
      "",
      "Portability decisions:",
      "- No `REGEXP` in the portable core (MySQL/MSSQL lack equivalent native semantics; capability-gated extension only).",
      "- Only `INNER` and `LEFT` joins in the grid-filter core (`RIGHT`/`FULL` only if a domain explicitly requires them).",
      "- `limit` is allowed only with deterministic `orderBy` (top-N semantics).",
      "- Empty Boolean groups and empty set values are invalid.",
      "- `where` and `having` share the predicate language, but aggregate operands are legal only in `having`/aggregate ordering.",
      "- Null is represented only by the null predicate, never as a comparison value.",
      "",
      "Validation limits (deployment configuration, not model-controlled):",
      "query text 500 chars; joins 4; predicate nodes 40; Boolean depth 6; set values 100;",
      "group fields 8; order items 4; limit 1–1000; response body 256 KB.",
      "Single canonical snake_case field names, no aliases.",
      "Any extra body fields are echoed back verbatim in `data.echo`.",
      "Omit `thread_id` / `request_id` to auto-generate UUIDs.",
    ].join("\n"),
    version: "2.0.0",
    contact: {
      name: "NlQuery_InfoQAAI Platform Team",
    },
  },
  servers: [
    { url: "/", description: "Current Host" },
    { url: "http://localhost:3000", description: "Local Development Server" },
  ],
  tags: [
    { name: "NL2SQL", description: "Natural language to AST v2 + certified SQL" },
    { name: "Health", description: "Health probes" },
    { name: "Config", description: "Domains, schema, skills, snapshot" },
  ],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        description: "Service status, registered table/domain counts, snapshot ref.",
        tags: ["Health"],
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "healthy" },
                    service: { type: "string", example: "NlQuery_InfoQAAI-backend" },
                    version: { type: "string", example: "2.0.0" },
                    tables_registered: { type: "integer", example: 3 },
                    domains_registered: { type: "integer", example: 2 },
                    snapshot_ref: { type: "string", example: "file-v1" },
                    timestamp: { type: "string", example: "2026-09-23T12:00:00.000Z" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/query": {
      post: {
        summary: "Synthesize AST v2 (App Engine → Query AI)",
        description: [
          "Translates one natural-language question into a strict AST v2 (`version 2.0`).",
          "App Engine sends `query`, `domain`, `ast_version`, `required_projection`, and `time_context` from trusted",
          "configuration/server time — the browser must not supply them.",
          "Relative-date predicates are resolved once by App Engine into start-inclusive/end-exclusive UTC timestamps",
          "using `time_context`; no database-specific current-date functions are compiled.",
          "If the question cannot be represented exactly, returns `status: unsupported` with `ast: null`;",
          "ambiguity returns `status: clarification_required` with a user-safe prompt and no AST.",
          "Never returns `success` with an incomplete, constant-false, or semantically weakened AST.",
        ].join("\n"),
        tags: ["NL2SQL"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/QueryRequestV2" },
              examples: {
                appEngineRequest: {
                  summary: "App Engine → Query AI request",
                  value: {
                    query: "show test sets having more than five test cases",
                    domain: "all_test_sets",
                    ast_version: "2.0",
                    required_projection: {
                      field: "TEST_SET_UUID",
                      output: "PARENT_UUID",
                      distinct: true,
                    },
                    time_context: {
                      time_zone: "Asia/Calcutta",
                      now: "2026-09-25T15:30:00+05:30",
                      week_starts_on: "MONDAY",
                    },
                    request_id: "uuid",
                    thread_id: "correlation-id",
                    include_traces: false,
                    include_ast: true,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Success (`status: success`) or clarification (`status: clarification_required`).",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/QuerySuccessEnvelope" },
                    { $ref: "#/components/schemas/QueryClarificationEnvelope" },
                  ],
                  discriminator: { propertyName: "status" },
                },
                examples: {
                  successMinimal: {
                    summary: "Successful response (minimal contract shape)",
                    value: {
                      status: "success",
                      request_id: "uuid",
                      thread_id: "correlation-id",
                      data: {
                        message: "All test sets.",
                        ast: {
                          version: "2.0",
                          root: { entity: "TEST_SET", alias: "ts" },
                          projection: {
                            field: { kind: "field", alias: "ts", field: "TEST_SET_UUID" },
                            distinct: true,
                            output: "PARENT_UUID",
                          },
                        },
                      },
                    },
                  },
                  successAggregate: {
                    summary: "Aggregate + HAVING example",
                    value: {
                      status: "success",
                      request_id: "uuid",
                      thread_id: "correlation-id",
                      data: {
                        message: "Test sets having more than five test cases.",
                        ast: {
                          version: "2.0",
                          root: { entity: "TEST_CASE", alias: "tc" },
                          projection: {
                            field: { kind: "field", alias: "tc", field: "TEST_SET_UUID" },
                            distinct: true,
                            output: "PARENT_UUID",
                          },
                          groupBy: [{ kind: "field", alias: "tc", field: "TEST_SET_UUID" }],
                          having: {
                            kind: "comparison",
                            left: { kind: "aggregate", function: "COUNT" },
                            operator: "GT",
                            right: { type: "number", value: 5 },
                          },
                        },
                      },
                    },
                  },
                  clarification: {
                    summary: "Ambiguity (no AST)",
                    value: {
                      status: "clarification_required",
                      request_id: "uuid",
                      thread_id: "correlation-id",
                      data: {
                        message: "Which test sets did you mean — personal or shared?",
                        reason_code: "AMBIGUOUS_QUERY",
                        ast: null,
                      },
                    },
                  },
                },
              },
            },
          },
          "400": {
            description:
              "Invalid payload, or blocked/error kind ({request_id, thread_id, status: 'error', data}). Conversational turns return 200 with sql: null.",
          },
          "422": {
            description: "Unsupported kind ({request_id, thread_id, status: 'unsupported', data with ast: null}).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/QueryUnsupportedEnvelope" },
                example: {
                  status: "unsupported",
                  request_id: "uuid",
                  thread_id: "correlation-id",
                  data: {
                    message: "This search cannot be represented by the supported query contract.",
                    reason_code: "UNSUPPORTED_OPERATION",
                    ast: null,
                  },
                },
              },
            },
          },
          "404": { description: "Unknown route: {status: 'error', error: 'Not found'}" },
          "500": {
            description: "Internal error: {status: 'error', error: 'Internal server error'}.",
          },
        },
      },
    },
    "/api/domains": {
      get: {
        summary: "List query domains",
        tags: ["Config"],
        responses: {
          "200": {
            description: "Registered domains",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    domains: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          canonical_name: { type: "string" },
                          description: { type: "string" },
                          allowed_tables: { type: "array", items: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/schema": {
      get: {
        summary: "Schema registry",
        description: "Controlled tables, columns, aliases, and join rules.",
        tags: ["Config"],
        responses: {
          "200": {
            description: "Schema definition: {tables: [...]}",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tables: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/skills": {
      get: {
        summary: "Agent skills",
        description: "Skill packs layered into generation.",
        tags: ["Config"],
        responses: {
          "200": {
            description: "Registered skills: {skills: [{name}]}",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    skills: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { name: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/config/reload": {
      post: {
        summary: "Reload config snapshot",
        description: "Reports the active snapshot ref (static file-v1).",
        tags: ["Config"],
        responses: {
          "200": {
            description: "Snapshot status: {status, message, ref}",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    message: { type: "string" },
                    ref: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      QueryRequestV2: {
        type: "object",
        required: ["query", "domain", "ast_version", "required_projection", "time_context"],
        additionalProperties: true,
        description:
          "App Engine → Query AI request. `domain`, `required_projection`, and `time_context` are derived by App Engine from trusted configuration and server time; the browser must not supply them. Extra scalar fields are echoed back verbatim in `data.echo`.",
        properties: {
          query: {
            type: "string",
            maxLength: 500,
            example: "show test sets having more than five test cases",
            description: "Natural-language question (required, max 500 chars).",
          },
          domain: {
            type: "string",
            example: "all_test_sets",
            description: "Registered domain pinning grid scope (e.g. `all_test_sets`). App Engine derived; router skipped.",
          },
          ast_version: {
            type: "string",
            enum: ["2.0"],
            example: "2.0",
            description: "AST contract version requested (v2 only).",
          },
          required_projection: { $ref: "#/components/schemas/RequiredProjection" },
          time_context: { $ref: "#/components/schemas/TimeContext" },
          request_id: {
            type: "string",
            description: "Optional caller request id (UUID). Auto-generated when omitted.",
          },
          thread_id: {
            type: "string",
            description: "Optional correlation/session id. Auto-generated when omitted.",
          },
          include_traces: {
            type: "boolean",
            default: false,
            description: "When true, includes deep per-stage LLM traces in telemetry. Defaults to false.",
          },
          include_ast: {
            type: "boolean",
            default: true,
            description:
              "AST tool gate (v2 LLM tool). Default true: `data.ast` carries the AST v2 JSON. Pass false to skip the ast-generator call and receive `ast: null`.",
          },
        },
      },
      RequiredProjection: {
        type: "object",
        required: ["field", "output", "distinct"],
        additionalProperties: false,
        description: "Grid projection lock from App Engine: parent UUID column, distinct, PARENT_UUID output.",
        properties: {
          field: {
            type: "string",
            example: "TEST_SET_UUID",
            description: "Configured parent UUID column (catalog identifier, e.g. `TEST_SET_UUID`).",
          },
          output: {
            type: "string",
            enum: ["PARENT_UUID"],
            example: "PARENT_UUID",
          },
          distinct: {
            type: "boolean",
            enum: [true],
            example: true,
          },
        },
      },
      TimeContext: {
        type: "object",
        required: ["time_zone", "now"],
        additionalProperties: false,
        description:
          "Trusted time context from App Engine. Resolves relative dates once into start-inclusive/end-exclusive UTC timestamps; never emits DB date functions.",
        properties: {
          time_zone: {
            type: "string",
            example: "Asia/Calcutta",
            description: "IANA time zone used for calendar semantics (e.g. `Asia/Calcutta`).",
          },
          now: {
            type: "string",
            format: "date-time",
            example: "2026-09-25T15:30:00+05:30",
            description: "Anchor time (RFC 3339 with offset/Z).",
          },
          week_starts_on: {
            type: "string",
            enum: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"],
            default: "MONDAY",
            example: "MONDAY",
          },
        },
      },
      EntityRef: {
        type: "object",
        required: ["entity", "alias"],
        additionalProperties: false,
        properties: {
          entity: { type: "string", example: "TEST_SET", description: "Catalog entity/table identifier." },
          alias: { type: "string", example: "ts" },
        },
      },
      FieldRef: {
        type: "object",
        required: ["kind", "alias", "field"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["field"] },
          alias: { type: "string", example: "ts" },
          field: { type: "string", example: "TEST_SET_UUID", description: "Catalog column identifier (never a value)." },
        },
      },
      Projection: {
        type: "object",
        required: ["field", "distinct", "output"],
        additionalProperties: false,
        description: "Grid projection, locked to the configured parent UUID.",
        properties: {
          field: { $ref: "#/components/schemas/FieldRef" },
          distinct: { type: "boolean", enum: [true] },
          output: { type: "string", enum: ["PARENT_UUID"] },
        },
      },
      JoinEquality: {
        type: "object",
        required: ["left", "right"],
        additionalProperties: false,
        properties: {
          left: { $ref: "#/components/schemas/FieldRef" },
          right: { $ref: "#/components/schemas/FieldRef" },
        },
      },
      Join: {
        type: "object",
        required: ["type", "entity", "alias", "on"],
        additionalProperties: false,
        description: "Grid-filter core supports INNER and LEFT only.",
        properties: {
          type: { type: "string", enum: ["INNER", "LEFT"] },
          entity: { type: "string", example: "TEST_CASE" },
          alias: { type: "string", example: "tc" },
          on: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/JoinEquality" },
          },
        },
      },
      TypedValue: {
        type: "object",
        required: ["type", "value"],
        discriminator: { propertyName: "type" },
        description: "Values remain values; never interchangeable with identifiers. Null only via the null predicate.",
        oneOf: [
          {
            type: "object",
            required: ["type", "value"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["string"] },
              value: { type: "string" },
            },
          },
          {
            type: "object",
            required: ["type", "value"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["number"] },
              value: { type: "number" },
            },
          },
          {
            type: "object",
            required: ["type", "value"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["boolean"] },
              value: { type: "boolean" },
            },
          },
          {
            type: "object",
            required: ["type", "value"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["date"] },
              value: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-09-25" },
            },
          },
          {
            type: "object",
            required: ["type", "value"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["datetime"] },
              value: {
                type: "string",
                format: "date-time",
                example: "2026-09-25T15:30:00+05:30",
                description: "RFC 3339 with offset/Z.",
              },
            },
          },
          {
            type: "object",
            required: ["type", "value"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["uuid"] },
              value: { type: "string", format: "uuid" },
            },
          },
        ],
      },
      AggregateExpr: {
        type: "object",
        required: ["kind", "function"],
        additionalProperties: false,
        description: "`field` omitted only for COUNT(*).",
        properties: {
          kind: { type: "string", enum: ["aggregate"] },
          function: { type: "string", enum: ["COUNT", "COUNT_DISTINCT", "MIN", "MAX", "SUM", "AVG"] },
          field: { $ref: "#/components/schemas/FieldRef" },
        },
      },
      Predicate: {
        type: "object",
        required: ["kind"],
        discriminator: { propertyName: "kind" },
        description:
          "`where` and `having` share this language, but aggregate operands are legal only in `having`/aggregate ordering. Empty Boolean groups and empty set values are invalid. Date example: `{kind: relativeDate, field, operator: IN_LAST, amount: 30, unit: DAY}` for “created in the last 30 days”.",
        oneOf: [
          { $ref: "#/components/schemas/ComparisonPredicate" },
          { $ref: "#/components/schemas/TextPredicate" },
          { $ref: "#/components/schemas/SetPredicate" },
          { $ref: "#/components/schemas/NullPredicate" },
          { $ref: "#/components/schemas/BetweenPredicate" },
          { $ref: "#/components/schemas/RelativeDatePredicate" },
          { $ref: "#/components/schemas/BooleanPredicate" },
          { $ref: "#/components/schemas/NotPredicate" },
        ],
      },
      ComparisonPredicate: {
        type: "object",
        required: ["kind", "left", "operator", "right"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["comparison"] },
          left: {
            oneOf: [
              { $ref: "#/components/schemas/FieldRef" },
              { $ref: "#/components/schemas/AggregateExpr" },
            ],
            description: "Aggregate left side legal only in `having`/aggregate ordering.",
          },
          operator: { type: "string", enum: ["EQ", "NE", "GT", "GTE", "LT", "LTE"] },
          right: { $ref: "#/components/schemas/TypedValue" },
        },
      },
      TextPredicate: {
        type: "object",
        required: ["kind", "field", "operator", "value"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["text"] },
          field: { $ref: "#/components/schemas/FieldRef" },
          operator: { type: "string", enum: ["CONTAINS", "STARTS_WITH", "ENDS_WITH"] },
          value: { type: "string", minLength: 1 },
          caseSensitive: { type: "boolean" },
        },
      },
      SetPredicate: {
        type: "object",
        required: ["kind", "field", "operator", "values"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["set"] },
          field: { $ref: "#/components/schemas/FieldRef" },
          operator: { type: "string", enum: ["IN", "NOT_IN"] },
          values: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { $ref: "#/components/schemas/TypedValue" },
          },
        },
      },
      NullPredicate: {
        type: "object",
        required: ["kind", "field", "operator"],
        additionalProperties: false,
        description: "Only representation of null; never a comparison value.",
        properties: {
          kind: { type: "string", enum: ["null"] },
          field: { $ref: "#/components/schemas/FieldRef" },
          operator: { type: "string", enum: ["IS_NULL", "IS_NOT_NULL"] },
        },
      },
      BetweenPredicate: {
        type: "object",
        required: ["kind", "field", "lower", "upper", "lowerInclusive", "upperInclusive"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["between"] },
          field: { $ref: "#/components/schemas/FieldRef" },
          lower: { $ref: "#/components/schemas/TypedValue" },
          upper: { $ref: "#/components/schemas/TypedValue" },
          lowerInclusive: { type: "boolean" },
          upperInclusive: { type: "boolean" },
        },
      },
      RelativeDatePredicate: {
        type: "object",
        required: ["kind", "field", "operator", "unit"],
        additionalProperties: false,
        description:
          "Explicit calendar semantics resolved by App Engine using `time_context` (time_zone + anchor `now`) into start-inclusive/end-exclusive UTC timestamps.",
        properties: {
          kind: { type: "string", enum: ["relativeDate"] },
          field: { $ref: "#/components/schemas/FieldRef" },
          operator: { type: "string", enum: ["IN_LAST", "IN_NEXT", "THIS", "PREVIOUS", "NEXT"] },
          amount: {
            type: "integer",
            minimum: 1,
            example: 30,
            description: "Required for IN_LAST/IN_NEXT; omitted for THIS/PREVIOUS/NEXT.",
          },
          unit: { type: "string", enum: ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"] },
        },
        example: {
          kind: "relativeDate",
          field: { kind: "field", alias: "ts", field: "AE_INSERT_TS" },
          operator: "IN_LAST",
          amount: 30,
          unit: "DAY",
        },
      },
      BooleanPredicate: {
        type: "object",
        required: ["kind", "operator", "children"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["boolean"] },
          operator: { type: "string", enum: ["AND", "OR"] },
          children: {
            type: "array",
            minItems: 2,
            maxItems: 40,
            items: { $ref: "#/components/schemas/Predicate" },
          },
        },
      },
      NotPredicate: {
        type: "object",
        required: ["kind", "child"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["not"] },
          child: { $ref: "#/components/schemas/Predicate" },
        },
      },
      OrderItem: {
        type: "object",
        required: ["expression", "direction"],
        additionalProperties: false,
        properties: {
          expression: {
            oneOf: [
              { $ref: "#/components/schemas/FieldRef" },
              { $ref: "#/components/schemas/AggregateExpr" },
            ],
          },
          direction: { type: "string", enum: ["ASC", "DESC"] },
          nulls: { type: "string", enum: ["FIRST", "LAST"] },
        },
      },
      QueryAstV2: {
        type: "object",
        required: ["version", "root", "projection"],
        additionalProperties: false,
        description:
          "Strict AST v2. Unknown keys rejected. Limits: joins 4, predicate nodes 40, Boolean depth 6, group fields 8, order items 4, limit 1–1000 (only with orderBy).",
        properties: {
          version: { type: "string", enum: ["2.0"], example: "2.0" },
          root: { $ref: "#/components/schemas/EntityRef" },
          projection: { $ref: "#/components/schemas/Projection" },
          joins: {
            type: "array",
            maxItems: 4,
            items: { $ref: "#/components/schemas/Join" },
          },
          where: { $ref: "#/components/schemas/Predicate" },
          groupBy: {
            type: "array",
            maxItems: 8,
            items: { $ref: "#/components/schemas/FieldRef" },
          },
          having: {
            $ref: "#/components/schemas/Predicate",
            description: "Aggregate operands legal here (first-class HAVING).",
          },
          orderBy: {
            type: "array",
            maxItems: 4,
            items: { $ref: "#/components/schemas/OrderItem" },
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Allowed only with deterministic `orderBy`.",
          },
        },
        example: {
          version: "2.0",
          root: { entity: "TEST_CASE", alias: "tc" },
          projection: {
            field: { kind: "field", alias: "tc", field: "TEST_SET_UUID" },
            distinct: true,
            output: "PARENT_UUID",
          },
          groupBy: [{ kind: "field", alias: "tc", field: "TEST_SET_UUID" }],
          having: {
            kind: "comparison",
            left: { kind: "aggregate", function: "COUNT" },
            operator: "GT",
            right: { type: "number", value: 5 },
          },
        },
      },
      QuerySuccessEnvelope: {
        type: "object",
        required: ["request_id", "thread_id", "status", "data"],
        properties: {
          request_id: { type: "string", example: "uuid" },
          thread_id: { type: "string", example: "correlation-id" },
          status: { type: "string", enum: ["success"], example: "success" },
          data: {
            type: "object",
            required: ["message", "ast"],
            properties: {
              message: { type: "string", example: "All test sets." },
              ast: { $ref: "#/components/schemas/QueryAstV2" },
              sql: {
                type: "string",
                nullable: true,
                example: "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts",
                description: "Certified read-only rendering agreeing with the AST (mysql/mssql compiled by App Engine).",
              },
              db_neutral_query: {
                type: "string",
                nullable: true,
                description: "Canonical DB-neutral SQL (portable LIKE form).",
              },
              dialect: { type: "string", enum: ["mysql", "mssql"], example: "mysql" },
              meta: {
                type: "object",
                properties: {
                  domain: { type: "string", example: "all_test_sets" },
                  intent: { type: "string", example: "filtering" },
                  complexity: { type: "string", example: "simple" },
                  tables: { type: "array", items: { type: "string" } },
                  unresolved: { type: "array", items: { type: "string" } },
                },
              },
              warnings: { type: "array", items: { type: "string" } },
              telemetry: {
                type: "object",
                properties: {
                  model: { type: "string", example: "gpt-4o-mini" },
                  totalLatencyMs: { type: "number", example: 8929 },
                  llmTokens: {
                    type: "object",
                    properties: {
                      inputTokens: { type: "number" },
                      outputTokens: { type: "number" },
                      totalTokens: { type: "number" },
                    },
                  },
                  llmCallsCount: { type: "number", example: 6 },
                  llmCost: { type: "number" },
                },
              },
              echo: {
                type: "object",
                description: "Caller fields echoed verbatim (plus any extra scalars).",
              },
            },
          },
        },
      },
      QueryUnsupportedEnvelope: {
        type: "object",
        required: ["request_id", "thread_id", "status", "data"],
        properties: {
          request_id: { type: "string" },
          thread_id: { type: "string" },
          status: { type: "string", enum: ["unsupported"], example: "unsupported" },
          data: {
            type: "object",
            required: ["message", "reason_code", "ast"],
            properties: {
              message: {
                type: "string",
                example: "This search cannot be represented by the supported query contract.",
              },
              reason_code: { type: "string", example: "UNSUPPORTED_OPERATION" },
              ast: { type: "object", nullable: true, example: null },
            },
          },
        },
      },
      QueryClarificationEnvelope: {
        type: "object",
        required: ["request_id", "thread_id", "status", "data"],
        properties: {
          request_id: { type: "string" },
          thread_id: { type: "string" },
          status: { type: "string", enum: ["clarification_required"], example: "clarification_required" },
          data: {
            type: "object",
            required: ["message", "ast"],
            properties: {
              message: {
                type: "string",
                example: "Which test sets did you mean — personal or shared?",
                description: "User-safe clarification prompt, no AST.",
              },
              reason_code: { type: "string", example: "AMBIGUOUS_QUERY" },
              ast: { type: "object", nullable: true, example: null },
            },
          },
        },
      },
    },
  },
};
