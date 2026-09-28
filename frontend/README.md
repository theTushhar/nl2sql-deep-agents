# NlQuery_InfoQAAI - Frontend

React 19 + Vite 8 chat interface for the Natural Language to SQL engine.

## Prerequisites

- Node.js 22+

## Quick Start

```bash
npm install
npm run dev    # Development (port 8080)
npm run build  # Production build
npm start      # Serve production build (port 8080)
npm run lint   # Lint with oxlint
```

Vite proxies `/api` requests to `http://localhost:3000` during development.

## Environment Variables

Copy `.env.example` to `.env` (see file for options). Production defaults to `https://nlquery-infoqaai.docs.infoapps.io`.

## Features

- **Chat Interface** — Ask questions in plain English, see results in real-time
- **SQL Display** — Formatted view of generated SQL
- **Data Tables** — Responsive tables for query results
- **Telemetry Panel** — Token usage, cost estimates, latency, and LLM traces
- **Unified REST API** — Connects to `POST /api/query` for fast data retrieval
- **Domain Selection** — Filter by query domain (e.g. `all_test_sets`)

## Docker

```bash
docker build -t infoqa-queryai-frontend .
docker run -p 8080:8080 infoqa-queryai-frontend
```

Uses multi-stage build (Node 22 Alpine). Serves static files on port 8080 with SPA history fallback.
