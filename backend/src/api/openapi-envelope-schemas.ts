export const openapiEnvelopeSchemas = {
  QueryRequestV2: {
    type: "object",
    required: ["query", "domain", "ast_version", "required_projection", "time_context"],
    additionalProperties: true,
    description:
      "App Engine → Query AI request. domain, required_projection, and time_context are derived by App Engine from trusted configuration and server time; browser must not supply them. Extra fields are accepted and ignored.",
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
        description: "Registered domain pinning grid scope (e.g. all_test_sets). App Engine derived; router skipped.",
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
          "AST gate. Default true: data.ast carries the AST v2 JSON. Pass false to skip AST generation and receive ast: null.",
      },
      include_sql: {
        type: "boolean",
        default: true,
        description:
          "SQL gate. Default true: data.sql carries the certified SQL. Pass false to skip SQL generation and receive sql: null. At least one of include_ast/include_sql must be true.",
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
        description: "Configured parent UUID column (catalog identifier, e.g. TEST_SET_UUID).",
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
        description: "IANA time zone used for calendar semantics (e.g. Asia/Calcutta).",
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
};
