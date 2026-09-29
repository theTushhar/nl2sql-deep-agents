# NlQuery_InfoQAAI - Backend

Hono 4.x HTTP service for Natural Language to SQL synthesis. A LangChain Deep
Agents runtime (`createDeepAgent`) runs three isolated subagents (planner →
writer → checker) under a single `LLM_MODEL`, and code-owned gates
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
- `src/agent/` — THE runtime: `agent.ts` (`createDeepAgent`), `coordinator.ts`
  (invoke → code gates → envelope), `subagents.ts` (3 stages: planner, writer,
  checker), `tools.ts` (snapshot readers), `schemas.ts` (responseFormats),
  `model.ts` (single `LLM_MODEL`), `tracing.ts` (Langfuse), `recorder.ts`.
- `src/domain/` — domain knowledge + deterministic gates (never authors SQL,
  never calls the LLM): `config.ts`, `guardrails.ts`, `sql-ast.ts`,
  `ast-validator.ts`, `response-composer.ts`, `schema-formatter.ts`.
- `src/contracts/` — frozen prod envelope (Zod schema + validation).
- `src/api/` — request schema, response mapper, OpenAPI spec.
- `prompts/` — `coordinator/planner/writer/checker.prompt.md` + `_safety.md` loaded at runtime
  (must ship with `dist/`).
- `skills/` — Agent Skills spec packs, served natively with progressive disclosure
  (must ship with `dist/`).
- `tests/` — `unit/` offline tests (vitest) + `integration/` live evals
  (`npm run contract`, `npm run eval:queries`, need API key).

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
| **`include_ast`** | `boolean` | Optional | `true` | AST v2 gate (`version: "2.0"`). Pass `false` to skip AST generation and receive `ast: null`. |
| **`request_id`** | `string` | Optional | Auto-generated UUID | Unique transaction ID for logs & telemetry tracking (alias: `requestId`). |
| **`thread_id`** | `string` | Optional | Auto-generated UUID | Conversational thread/session ID for multi-turn session tracking in Langfuse (alias: `threadId`). |
| **`user_id`** | `string` | Optional | — | User identifier for session and telemetry tracking (alias: `userId`). |
| **`context_filters`** | `object` | Optional | — | Accepted and ignored (no echo in the response). |
| **`execute`** | `boolean` | Optional | `false` | Flag indicating whether the caller intends to execute the generated query against the DB. |
| **`nl_query`** | `string` | Optional | — | Deprecated alias of `query`. |
| **`question`** | `string` | Optional | — | Deprecated alias of `query`. |

