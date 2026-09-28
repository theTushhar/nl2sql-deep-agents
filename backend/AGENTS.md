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

Hono 4.x HTTP service. Deterministic query coordinator delegates to scoped
LLM agents (`input-guard → query-normalizer → domain-router →
schema-explorer + business-rules → certification-gate → response-composer`)
and only emits critic-certified, read-only MySQL/MSSQL.

Runtime halves (Deep Agents pattern):

```
client (Swagger / frontend / curl)
  ── POST /api/query ──▶ agent server (this backend)
                          ├─ agent runtime (src/agents/*)
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
├── prompts/                   ← LLM prompt text ONLY ({{variables}} filled by code)
│   ├── input-guard.prompt.md
│   ├── query-normalizer.prompt.md
│   ├── domain-router.prompt.md
│   ├── schema-explorer.prompt.md
│   ├── business-rules.prompt.md
│   ├── sql-writer.prompt.md
│   └── sql-critic.prompt.md
├── skills/                    ← Agent Skills spec packs (SKILL.md per skill)
│   ├── general/query-writing/SKILL.md
│   ├── domains/all-test-sets/SKILL.md
│   └── critic/query-critic/SKILL.md
├── src/
│   ├── agents/                ← one folder/file per pipeline agent (was subagents/)
│   ├── orchestration/         ← coordinator + certification-gate (was shell/)
│   ├── prompting/             ← prompt template loader (was src/prompts/loader.ts)
│   ├── skills/                ← skill loader (skill-loader.ts)
│   ├── tools/                 ← read-only snapshot tools (snapshot-tools.ts, schema-formatter.ts)
│   ├── config/                ← domain-config.ts (schema + jargon rules), env-validation.ts
│   ├── api/                   ← Hono routes + schemas (was http/ + docs/)
│   └── contracts/             ← frozen prod envelope (query-envelope.ts)
└── evals/                     ← contract checks, golden queries
```

Naming rules:

- `src/agents/<stage>.agent.ts` — agent logic (LLM call + parsing).
  `debugger.ts` was renamed to `query-normalizer.agent.ts` because it
  normalizes queries; it never debugs code.
- `src/orchestration/` — deterministic pipeline shell (never authors SQL).
  `shell/` was renamed because "shell" means terminal to most engineers.
- `prompts/<stage>.prompt.md` — prompt filename MUST match its agent file.
- `src/tools/` — pure, read-only data accessors over the config snapshot.
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
2. Edit ONLY the `.prompt.md` file. Keep `{{variables}}` intact and keep
   STRICT JSON schemas byte-identical unless you also update the parser
   in the matching `src/agents/*.agent.ts`.
3. Verify: `npm run typecheck`, then the render-check in `PROMPTMAP.md`.

Prompt text lives in `prompts/`; code only computes `{{variables}}`.
Never duplicate prompt wording into `.ts` files.

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
- Register in `src/skills/skill-loader.ts` (`resolveSkillsForContext`) and
  in `GET /api/v1/skills` (`src/server.ts` or `src/api/*`).

## 7. Adding a subagent (Deep Agents subagent spec)

Each agent is `{name, description, system_prompt, tools, model, skills}`:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | kebab-case, e.g. `schema-explorer` |
| `description` | yes | Action-oriented; coordinator uses it to decide delegation |
| `system_prompt` | yes (isolated mode) | = body of `prompts/<name>.prompt.md`; isolated agents see only the delegated task |
| `tools` | no | Minimal set only; inherits main agent's tools if omitted |
| `model` | no | `provider:model` override; omit to inherit (generic `resolveLlmModel("SIMPLE_MODEL"\|"COMPLEX_MODEL")`) |
| `skills` | no | Skill source paths; isolated per agent (not shared with parent) |

Steps:

1. Create `src/agents/<name>.agent.ts` exporting `<verb><Noun>` +
   `Input`/`Output` types (see `schema-explorer.agent.ts`).
2. Create `prompts/<name>.prompt.md` with frontmatter
   `name/owner/used_by/when/variables`.
3. Export from `src/agents/index.ts` (`agents-registry`).
4. Wire into `src/orchestration/query-coordinator.ts` in order;
   record stage + triggers for telemetry.
5. Add prompt row to `PROMPTMAP.md`.

Prefer `isolated` (default) for context quarantine. Use `fork` only to
continue work the parent already started.

## 8. Config ownership (schema + business jargon)

Single source: `src/config/domain-config.ts` (`DEFAULT_SNAPSHOT`).
Subagents never touch it directly — only via `loadSnapshot()` + tools.

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
npm run typecheck   # tsc --noEmit
npm test            # vitest run (23 tests)
npm run contract    # live contract checks (needs OPENAI_API_KEY)
```

Search hygiene: target `src/agents`, `src/orchestration`, `prompts`,
`skills`, `src/config`. Exclude `node_modules`, `dist`.
