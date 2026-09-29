# NlQuery_InfoQAAI - Backend

Hono 4.x HTTP service for Natural Language to SQL synthesis. A LangChain Deep
Agents runtime (`createDeepAgent`) runs isolated subagents (input-guard,
query-normalizer, domain-router, schema-explorer, business-rules, sql-writer +
sql-critic, ast-generator) under a single `LLM_MODEL`, and code-owned gates
only emit statically-certified MySQL.

Start here: `AGENTS.md` (default system prompt + repo rules), then
`PROMPTMAP.md` (which prompt file to tune), then `docs/deep-agents.md`
(full Deep Agents reference).

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
- `src/deepagents/` — THE runtime: `agent.ts` (`createDeepAgent`), `subagents.ts`
  (9 stages), `tools.ts` (snapshot readers), `schemas.ts` (responseFormats),
  `ast.ts` (AST validation), `model.ts` (single `LLM_MODEL`), `tracing.ts`
  (Langfuse), `coordinator-deep.ts` (invoke → code gates → envelope).
- `src/orchestration/` — deterministic code gates (never authors SQL, never calls
  the LLM): `sql-ast.ts`, `response-composer.ts`, `sql-guardrails.ts`.
- `src/contracts/` — frozen prod envelope (Zod schema + validation).
- `src/config/domain-config.ts` — schema registry + business jargon rules.
- `src/api/` — request schema, response mapper, OpenAPI spec.
- `prompts/` — `*.prompt.md` templates loaded at runtime (must ship with `dist/`).
- `skills/` — Agent Skills spec packs, served natively with progressive disclosure
  (must ship with `dist/`).
- `evals/` — live contract checks (`npm run contract`) + golden fixtures.

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
| **`include_traces`** | `boolean` | Optional | `false` | Accepted for contract compat (deep-path traces live in Langfuse, not the payload). |
| **`include_ast`** | `boolean` | Optional | `true` | AST v2 gate (`version: "2.0"`). Pass `false` to skip the ast-generator subagent and receive `ast: null`. |
| **`request_id`** | `string` | Optional | Auto-generated UUID | Unique transaction ID for logs & telemetry tracking (alias: `requestId`). |
| **`thread_id`** | `string` | Optional | Auto-generated UUID | Conversational thread/session ID for multi-turn session tracking in Langfuse (alias: `threadId`). |
| **`user_id`** | `string` | Optional | — | User identifier for session and telemetry tracking (alias: `userId`). |
| **`context_filters`** | `object` | Optional | — | Custom session, tenant, or execution context filters to apply or echo back (alias: `contextFilters`). |
| **`execute`** | `boolean` | Optional | `false` | Flag indicating whether the caller intends to execute the generated query against the DB. |
| **`nl_query`** | `string` | Optional | — | Deprecated alias of `query`. |
| **`question`** | `string` | Optional | — | Deprecated alias of `query`. |

