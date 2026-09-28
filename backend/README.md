# NlQuery_InfoQAAI - Backend

Hono 4.x HTTP service for Natural Language to SQL synthesis. A deterministic
coordinator delegates to scoped LLM agents (input-guard, query-normalizer,
domain-router, schema-explorer, business-rules, sql-writer + sql-critic) and
only emits critic-certified MySQL.

Start here: `AGENTS.md` (default system prompt + repo rules), then
`PROMPTMAP.md` (which prompt file to tune).

## Prerequisites

- Node.js 22+
- OpenAI-compatible API key (`OPENAI_API_KEY`)

## Quick Start

```bash
npm ci
npm run dev    # Development (port 3000, watch mode)
npm run build  # Compile TypeScript to dist/
npm start      # Production (node dist/index.js)
npm run contract # Live contract checks over the coordinator (needs API key)
```

Copy `.env.example` to `.env` and configure.

## Project Structure

- `src/server.ts` — Hono app: `POST /api/query`, health, schema/skills discovery.
- `src/orchestration/query-coordinator.ts` — deterministic pipeline (never authors SQL).
- `src/orchestration/llm-client.ts` — cheap-tier LLM client with Langfuse generations.
- `src/orchestration/observability.ts` — Langfuse trace/session/user wiring + per-request records.
- `src/orchestration/certification-gate.ts` — writer+critic retry loop (only SQL exit path).
- `src/agents/` — input-guard, query-normalizer, domain-router, schema-explorer,
  business-rules, sql-writer, sql-critic, response-composer (+ sql-guardrails).
- `src/contracts/` — frozen prod envelope (Zod schema + validation).
- `src/config/domain-config.ts` — schema registry + business jargon rules.
- `src/api/` — request schema, response mapper, OpenAPI spec.
- `prompts/` — `*.prompt.md` templates loaded at runtime (must ship with `dist/`).
- `skills/` — `SKILL.md` prompt packs layered into generation (must ship with `dist/`).
- `evals/` — contract checks and shadow-phase harnesses.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health |
| POST | `/api/query` | NL-to-certified-SQL synthesis |
| GET | `/api/domains` | List query domains |
| GET | `/api/v1/schema` | Schema registry |
| GET | `/api/v1/skills` | Registered Agent Skills |
| GET | `/openapi.json` | OpenAPI spec |
| GET | `/docs` | Swagger UI |

### `POST /api/query` Request Body Parameters

| Parameter | Type | Required / Optional | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`query`** | `string` | **Required** | — | Natural-language query (max 1500 chars). |
| **`domain`** | `string` | Optional | `"default"` | Target domain. `"all_test_sets"` pins UI grid subquery (`SELECT DISTINCT ts.TEST_SET_UUID`); `"default"` auto-routes. |
| **`dialect`** | `string` | Optional | `"mysql"` | SQL rendering dialect (`"mysql"` or `"mssql"`). |
| **`include_traces`** | `boolean` | Optional | `false` | When `true`, includes deep per-stage LLM traces (`prompt` & `response`) in `data.telemetry`. Defaults to `false` for clean payloads. |
| **`include_ast`** | `boolean` | Optional | `true` | AST tool gate (v1-clean, `ast_version: "0.1.0"`). Pass `false` to skip the `buildAstTool` call and receive `ast: null`. |
| **`request_id`** | `string` | Optional | Auto-generated UUID | Unique transaction ID for logs & telemetry tracking (alias: `requestId`). |
| **`thread_id`** | `string` | Optional | Auto-generated UUID | Conversational thread/session ID for multi-turn session tracking in Langfuse (alias: `threadId`). |
| **`user_id`** | `string` | Optional | — | User identifier for session and telemetry tracking (alias: `userId`). |
| **`context_filters`** | `object` | Optional | — | Custom session, tenant, or execution context filters to apply or echo back (alias: `contextFilters`). |
| **`execute`** | `boolean` | Optional | `false` | Flag indicating whether the caller intends to execute the generated query against the DB. |
| **`nl_query`** | `string` | Optional | — | Deprecated alias of `query`. |
| **`question`** | `string` | Optional | — | Deprecated alias of `query`. |

