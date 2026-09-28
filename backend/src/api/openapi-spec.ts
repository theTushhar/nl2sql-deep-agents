// OpenAPI spec for NlQuery_InfoQAAI backend (mirrors src/server.ts routes).
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "NlQuery_InfoQAAI — NL2SQL API",
    description: [
      "Stateless Natural Language to SQL synthesis.",
      "Send `query`; receive certified read-only MySQL plus AST and telemetry.",
      "",
      "Request aliases: `nl_query` / `question` are deprecated aliases of `query`",
      "(precedence `query` > `nl_query` > `question`).",
      "Any extra body fields are echoed back verbatim in `data.echo`.",
      "Omit `thread_id` / `request_id` to auto-generate UUIDs.",
    ].join("\n"),
    version: "0.1.0",
    contact: {
      name: "NlQuery_InfoQAAI Platform Team",
    },
  },
  servers: [
    { url: "/", description: "Current Host" },
    { url: "http://localhost:3000", description: "Local Development Server" },
  ],
  tags: [
    { name: "NL2SQL", description: "Natural language to certified SQL" },
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
                    version: { type: "string", example: "0.1.0" },
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
        summary: "Synthesize certified SQL",
        description:
          "Translates one natural-language question into a single critic-certified SELECT. Read-only; no bind variables emitted.",
        tags: ["NL2SQL"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["query"],
                properties: {
                  query: {
                    type: "string",
                    maxLength: 1500,
                    example: "show personal test sets",
                    description: "Natural-language question (required).",
                  },
                  domain: {
                    type: "string",
                    default: "default",
                    example: "all_test_sets",
                    description: "'all_test_sets' pins the grid domain (router skipped); 'default' auto-routes.",
                  },
                  dialect: {
                    type: "string",
                    default: "mysql",
                    example: "mysql",
                    enum: ["mysql", "mssql"],
                    description: "SQL rendering dialect.",
                  },
                  thread_id: {
                    type: "string",
                    description: "Optional session id (alias: threadId). Auto-generated when omitted.",
                  },
                  request_id: {
                    type: "string",
                    description: "Optional caller request id (alias: requestId). Auto-generated when omitted.",
                  },
                  nl_query: {
                    type: "string",
                    deprecated: true,
                    description: "Deprecated alias of query. Prefer query.",
                  },
                  include_traces: {
                    type: "boolean",
                    default: false,
                    description: "When true, includes deep per-stage LLM traces (prompts & responses) in telemetry. Defaults to false for clean payloads.",
                  },
                  include_ast: {
                    type: "boolean",
                    default: true,
                    description:
                      "AST tool gate (v1-clean, ast_version 0.1.0). Default true: data.ast carries {ast_version, select, from, joins?, where?, group_by?, order_by?, limit?}. Pass false to skip the buildAstTool call and receive ast: null.",
                  },
                  user_id: {
                    type: "string",
                    description: "Optional user ID for session tracking and user-scoped filtering (alias: userId).",
                  },
                  context_filters: {
                    type: "object",
                    description: "Optional tenant or session filters to echo back or pass through (alias: contextFilters).",
                  },
                  execute: {
                    type: "boolean",
                    default: false,
                    description: "Optional flag indicating whether caller intends to execute the generated query against DB.",
                  },
                  question: {
                    type: "string",
                    deprecated: true,
                    description: "Deprecated alias of query. Prefer query.",
                  },
                },
              },
              example: {
                query: "show personal test sets",
                domain: "all_test_sets",
                dialect: "mysql",
                include_traces: false,
                include_ast: true,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Certified query envelope",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["request_id", "thread_id", "status", "data"],
                  properties: {
                    request_id: { type: "string", example: "req-1726569100000" },
                    thread_id: { type: "string", example: "thr-1726569100000" },
                    status: { type: "string", example: "success", enum: ["success", "error"] },
                    data: {
                      type: "object",
                      description:
                        "Fields are ordered for readability: message → sql → meta → ast → telemetry → echo. sql/message are null on blocked/error paths.",
                      required: ["message", "sql", "dialect", "meta", "telemetry"],
                      properties: {
                        message: { type: "string", nullable: true },
                        sql: {
                          type: "string",
                          nullable: true,
                          example:
                            "SELECT DISTINCT ts.TEST_SET_UUID FROM TEST_SET ts WHERE ts.TEST_SET_TYPE = 'Personal'",
                        },
                        db_neutral_query: {
                          type: "string",
                          nullable: true,
                          description: "Dialect-neutral logical SQL (REGEXP form).",
                        },
                        dialect: { type: "string", example: "mysql", enum: ["mysql", "mssql"] },
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
                        ast: {
                          type: "object",
                          nullable: true,
                          description:
                            "Deterministic AST v1-clean (ast_version 0.1.0): {ast_version, select[{col|count,as?,distinct?}], from{table,as}, joins?[{type,table,as,on}], where?[{col,op,val}|{and}|{or}|{raw}], group_by?, order_by?, limit?}. Omit-when-empty; null when include_ast=false or on non-success kinds.",
                        },
                        telemetry: {
                          type: "object",
                          description:
                            "llmCallsCount = real completions incl. writer/critic retries. llmCost rounded to 6dp.",
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
                            llmTraces: {
                              type: "array",
                              description: "One entry per LLM call: {prompt, response, stage, model, latencyMs}.",
                              items: {
                                type: "object",
                                properties: {
                                  prompt: { type: "string" },
                                  response: { type: "string" },
                                  stage: { type: "string" },
                                  model: { type: "string" },
                                  latencyMs: { type: "number" },
                                },
                              },
                            },
                          },
                        },
                        echo: {
                          type: "object",
                          description: "Caller fields echoed verbatim (domain, dialect, ids, plus any extra scalars).",
                        },
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
};
