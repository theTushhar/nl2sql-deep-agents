import { openapiEnvelopeSchemas } from "./openapi-envelope-schemas";
import { openapiAstSchemas } from "./openapi-ast-schemas";

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "NlQuery_InfoQAAI — Query AI AST v2 API",
    description:
      "Stateless Natural Language to AST v2 synthesis with certified SQL rendering and telemetry.",
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
        description:
          "Translates one natural-language question into a strict AST v2 and certified SQL.",
        tags: ["NL2SQL"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/QueryRequestV2" },
            },
          },
        },
        responses: {
          "200": {
            description: "Query synthesized successfully or clarification required",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/QuerySuccessEnvelope" },
                    { $ref: "#/components/schemas/QueryClarificationEnvelope" },
                  ],
                },
              },
            },
          },
          "400": {
            description: "Invalid payload or blocked query",
          },
          "422": {
            description: "Unsupported query",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/QueryUnsupportedEnvelope" },
              },
            },
          },
          "404": {
            description: "Unknown route",
          },
          "500": {
            description: "Internal error or synthesis failure",
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
        description: "Controlled tables, columns, and join rules.",
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
            description: "Registered skills",
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
        description: "Reports the active snapshot ref.",
        tags: ["Config"],
        responses: {
          "200": {
            description: "Snapshot status",
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
      ...openapiEnvelopeSchemas,
      ...openapiAstSchemas,
    },
  },
};
