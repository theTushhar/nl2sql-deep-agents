# NLQuery_InfoQA Query AI

Natural Language to SQL engine. Translates plain English questions into critic-certified MySQL queries, returned as JSON with telemetry (tokens, cost, latency, per-call traces).

## How It Works

1. User asks a question (e.g. "How many test cases are present?")
2. Deterministic coordinator classifies intent, selects relevant schema, and generates a MySQL query via scoped subagents
3. Query is certified (SELECT-only, schema-checked, max 3 writer/critic rounds)
4. Results are returned as JSON with telemetry (tokens, cost, latency)

## Project Structure

- [`backend/`](./backend) — Hono 4.x API service, subagent pipeline, Langfuse tracing
- [`frontend/`](./frontend) — React 19 + Vite 8 chat interface  