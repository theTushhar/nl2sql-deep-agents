# AGENTS.md — InfoQA NL-to-SQL Backend

> Default system prompt + contributor rules for this service.
> Follows the Deep Agents community scaffold conventions:
> LangChain Deep Agents (`AGENTS.md` memory, `skills/<skill>/SKILL.md`,
> `.deepagents/agents/<name>/AGENTS.md` subagents, progressive disclosure).
> Source: https://docs.langchain.com/oss/python/deepagents/overview ,
> https://docs.langchain.com/oss/python/deepagents/subagents ,
> https://docs.langchain.com/oss/python/deepagents/skills ,
> https://github.com/langchain-ai/deepagents/blob/main/AGENTS.md
>
> Note on naming: the community standard is `AGENTS.md` (plural).
> `AGENT.md` (singular) is accepted as an alias — if you create one,
> keep it as a one-line pointer to this file, not a second copy.

## 1. What this service is

Hono 4.x HTTP service. LangChain Deep Agents runtime (`createDeepAgent`) runs
the NL-to-SQL pipeline (`input-guard → query-normalizer (domain-agnostic) →
domain resolution (pinned request domain wins, router only for
default/unpinned) → domain-rephraser → schema-explorer + business-rules →
sql-writer → sql-critic → ast-generator`)
and only emits statically-certified, read-only MySQL/MSSQL. Single model
(`LLM_MODEL`) for the main agent and all subagents.

Runtime halves (Deep Agents pattern):

```
client (Swagger / frontend / curl)
  ── POST /api/query ──▶ agent server (this backend)
                           ├─ agent runtime (src/deepagents/*)
                           ├─ tools, skills, config snapshot
                           └─ Langfuse tracing
```

## 2. Default system prompt (all agents inherit tone + safety)

```
You are part of the InfoQA Test Management NL-to-SQL pipeline.
Formal, proper tone at all times. Never casual, never slang.
Read-only SELECT only. Never invent tables, columns, or joins.
Prefer explicit columns over SELECT *. Tenant isolation and user
filtering are applied by the consuming service — never invent
identity predicates or bind variables.
If the request is a greeting, out-of-scope chatter, or malicious,
do not produce SQL; return the conversational or blocked path.
```

Stage prompts in `prompts/*.prompt.md` extend this — they never replace it.

## 3. Repository layout (industry-standard names)

```
backend/
├── AGENTS.md                  ← this file (default prompt + rules)
├── PROMPTMAP.md               ← prompt tuning index (which .md to edit)
├── prompts/                   ← LLM prompt text ONLY (facts arrive via tools + task description)
│   ├── input-guard.prompt.md
│   ├── query-normalizer.prompt.md
│   ├── domain-router.prompt.md
│   ├── schema-explorer.prompt.md
│   ├── business-rules.prompt.md
│   ├── sql-writer.prompt.md
│   ├── sql-critic.prompt.md
│   └── ast-generator.prompt.md
├── skills/                    ← Agent Skills spec packs (SKILL.md per skill)
│   ├── general/query-writing/SKILL.md
│   ├── domains/all-test-sets/SKILL.md
│   └── critic/query-critic/SKILL.md
├── src/
│   ├── deepagents/            ← THE runtime: agent.ts, subagents.ts, tools.ts,
│   │                             schemas.ts, ast.ts, model.ts (LLM_MODEL),
│   │                             tracing.ts, prompts.ts, types.ts, coordinator-deep.ts
│   ├── orchestration/         ← deterministic code gates (never authors SQL):
│   │                             coordinator-deep support — sql-ast.ts,
│   │                             response-composer.ts, sql-guardrails.ts
│   ├── prompting/             ← prompt template loader (for scripts/prompts-check.ts)
│   ├── tools/                 ← schema-formatter.ts (used by deepagents/tools.ts)
│   ├── config/                ← domain-config.ts (schema + jargon rules), env-validation.ts
│   ├── api/                   ← Hono routes + schemas (was http/ + docs/)
│   └── contracts/             ← frozen prod envelope (query-envelope.ts)
└── evals/                     ← contract checks, golden queries
```

Naming rules:

- `src/deepagents/<area>.ts` — one concern per file (model, prompts, tools,
  schemas, subagents, ast, tracing, coordinator). No per-stage `.agent.ts`
  files: stages are `SubAgent` entries in `subagents.ts`.
- `src/orchestration/` — deterministic gates + pure composition (never authors
  SQL, never calls the LLM).
- `prompts/<stage>.prompt.md` — prompt filename MUST match its subagent `name`.
- `src/tools/` — pure formatters over the config snapshot.
  No keyword scoring, no regex intent matching.

## 4. Core development principles (from Deep Agents AGENTS.md)

- Preserve exported function signatures, argument positions, names.
  Add new params as optional with defaults; warn on any signature change.
- Keep functions under ~20 lines; split longer ones into focused helpers.
- Type everything; avoid `any`. Google-style docstrings on public fns.
- American English, single backticks for inline code.
- Descriptive single-word variable names where readable.
- No `eval`/`exec`/pickle on user input. Clean up files, sockets, handles.
- Tests assert observable behavior, not call order. Network-free tests in
  `src/**/*.test.ts`. Run `npm run typecheck` + `npm test` before pushing.

## 5. Prompt tuning (no code changes needed)

1. Find the behavior row in `PROMPTMAP.md`.
2. Edit ONLY the `.prompt.md` file. Keep output-shape blocks aligned with the
   matching zod schema in `src/deepagents/schemas.ts` (strict SQL/AST
   validation lives in code and does not change).
3. Verify: `npm run typecheck`, then the render-check in `PROMPTMAP.md`.

Prompt text lives in `prompts/`; subagents fetch facts via tools + task
description. Never duplicate prompt wording into `.ts` files.

## 6. Adding a skill (Agent Skills spec + progressive disclosure)

```
skills/<group>/<skill-name>/SKILL.md
skills/<group>/<skill-name>/references/   ← on-demand docs (optional)
skills/<group>/<skill-name>/scripts/      ← executable helpers (optional)
skills/<group>/<skill-name>/assets/       ← templates, schemas (optional)
```

`SKILL.md` format:

```md
---
name: my-skill
description: What it does + WHEN to activate it (specific keywords).
---
# My Skill
Step-by-step instructions, decision criteria, examples, edge cases.
```

Rules (Deep Agents community):

- Level 1 metadata (`name` + `description`) loads at startup for every
  skill — keep frontmatter concise; body under ~5,000 tokens / 500 lines.
- Level 2 instructions load only when the skill is invoked.
- Level 3 `references/`/`scripts/`/`assets/` load only when instructions
  reference them, one level deep. No nested chains.
- Specific descriptions (`Extract text from PDFs… Use when…`) beat vague
  ones (`Helps with PDFs`). Overlapping descriptions degrade selection —
  consolidate instead of multiplying skills.
- Register skill packs in `src/deepagents/subagents.ts` (`skills` per subagent)
  and in `GET /api/v1/skills` (`src/server.ts`).

## 7. Adding a subagent (Deep Agents subagent spec)

Each subagent is `{name, description, systemPrompt, tools, responseFormat, skills}`:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | kebab-case, e.g. `schema-explorer`; MUST match `prompts/<name>.prompt.md` |
| `description` | yes | Action-oriented; main agent uses it to decide delegation |
| `systemPrompt` | yes (isolated mode) | = body of `prompts/<name>.prompt.md`; isolated agents see only the delegated task |
| `tools` | no | Minimal set only (snapshot readers); `[]` when the stage needs none |
| `model` | no | Always omitted — every subagent inherits the single `LLM_MODEL` |
| `responseFormat` | no | zod schema from `src/deepagents/schemas.ts`; parent receives JSON |
| `skills` | no | Skill source paths; isolated per agent (not shared with parent) |

Steps:

1. Create `prompts/<name>.prompt.md` with frontmatter
   `name/owner/used_by/when/variables`.
2. Add the zod `responseFormat` to `src/deepagents/schemas.ts`.
3. Add the `SubAgent` entry in `src/deepagents/subagents.ts` in pipeline order.
4. Extend the coordinator workflow in `src/deepagents/agent.ts` system prompt.
5. Add prompt row to `PROMPTMAP.md`.

Prefer `isolated` (default) for context quarantine. Use `fork` only to
continue work the parent already started.

Deep Agents runtime (`src/deepagents/`): prompt-driven over `createDeepAgent` —
`model.ts` (single-`LLM_MODEL` factory), `schemas.ts` (zod `responseFormat`),
`tools.ts` (read-only snapshot as `tool()`s), `subagents.ts` (9 stages,
`systemPrompt` loaded from `prompts/*.prompt.md`), `agent.ts`
(`memory: ["./AGENTS.md"]`, `skills: ["/skills/"]`, `FilesystemBackend`,
`MemorySaver`), `tracing.ts` (Langfuse trace per request), `coordinator-deep.ts`
(delegates the workflow, then fail-closed code gates + `composeResponse`).
Verify offline with `npm run deep:smoke` (no LLM cost).

## 8. Config ownership (schema + business jargon)

Single source: `src/config/domain-config.ts` (`DEFAULT_SNAPSHOT`).
Subagents never touch it directly — only via snapshot `tool()`s.

- `domains[].allowedTables` — domain scope. Empty = all tables.
- `tables[]` — `table_name, alias, description, primaryKey,
  columns[{name,type,searchable,allowed_values?,description?}], joins[]`.
  `searchable` gates LIKE/REGEXP; `joins` gate JOIN validation.
- `businessRules[]` — `{id, target_table, target_column?, sql_clause,
  description, is_default?}`. The interpreter LLM selects IDs by meaning;
  code joins `sql_clause` deterministically. Never put trigger keywords
  in descriptions.
- Future: same shape moves to DB/file without redeploy; agents keep
  calling `loadSnapshot()`.

## 9. Verification

```powershell
npm run typecheck    # tsc --noEmit
npm test             # vitest run (unit, no LLM)
npm run prompts:check# prompt frontmatter + variable match (no LLM)
npm run deep:smoke   # deep wiring constructs offline (no LLM)
npm run contract     # live contract checks (needs LLM key)
```

Search hygiene: target `src/deepagents`, `src/orchestration`, `prompts`,
`skills`, `src/config`. Exclude `node_modules`, `dist`.
