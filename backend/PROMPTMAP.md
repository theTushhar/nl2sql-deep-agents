# PROMPTMAP — prompt tuning index

All LLM wording lives in `prompts/*.prompt.md` plus the shared footer
`prompts/_safety.md` (auto-appended to every stage by `loadStagePrompt`).
**To tune any behavior, edit the `.prompt.md` file only — never
`src/agent/agent.ts` or `src/agent/subagents.ts`.** Each prompt body
becomes a `systemPrompt` (facts arrive via tools + task description at
runtime). Single model: `LLM_MODEL` for everything (subagents inherit;
per-prompt `model_env` is informational).

Self-service rules:
- Each prompt is an isolated subagent with its own context window. The main agent
  passes only task-scoped facts in the `task` description (question, domain,
  tables, filters, catalog text, time context) — never full transcripts.
- Subagent outputs are zod-`responseFormat` enforced (`src/agent/schemas.ts`);
  strict re-validation of SQL/AST stays in code (`coordinator.ts`).
- Run `npm run prompts:check` after editing (no LLM cost).

See `AGENTS.md` §5 for the workflow and `docs/deep-agents.md` for the full reference.
The architecture has been unified into 3 lean subagents (`planner`, `writer`, `checker`) plus coordinator dispatch.

## Map

| Tune this behavior | Edit this file | Owner (do not edit for wording) | Runs | Facts (via tools / task description) |
|---|---|---|---|---|
| Dispatcher workflow (delegation order, checker policy, retry budget, FinalAnswer rules) | `prompts/coordinator.prompt.md` | `src/agent/agent.ts` (wiring only) | main agent, every request | planner JSON + writer SQL in `task` descriptions |
| Safety + normalization + domain + table/rule planning (greetings, synonyms, routing, relevance, search scope, LIKE patterns, complexity, rule selection) | `prompts/planner.prompt.md` | `src/agent/subagents.ts` (`planner`) | 1st stage, every request | snapshot tools (`list_domains`, `find_tables`, `get_table_schema`, `list_searchable_columns`, `list_business_rules` with the planner domain) |
| SQL + AST generation (schema use, aliases, LIKE discipline, projection, AST v2 mirror, domain-skill routing) | `prompts/writer.prompt.md` | `src/agent/subagents.ts` (`writer`) | after planner, every data request | ONE `get_context` call + planner JSON + time context in description; domain skill auto-loaded via SkillsMiddleware |
| SQL safety screen, fix notes for the writer retry (text-only, no tools; code gate is authoritative) | `prompts/checker.prompt.md` | `src/agent/subagents.ts` (`checker`) | after writer, only on uncertainty/risk | candidate SQL + domain in description |
| User-facing copy (no LLM cost, pure template) | `src/domain/response-composer.ts` (`composeResponse`, code-owned) | — | every terminal path | `question, tables, dialect, intent` |
| Generation style: read-only, aliases, JOINs, projection guidance | writer prompt (generic mechanics) + domain skills below | writer subagent | every generation | (none — progressive disclosure) |
| Flexible reporting projection (explicit columns, aggregates, grouping) | `skills/default-reporting/SKILL.md` | writer subagent `skills` | default-domain generations | (none — progressive disclosure) |
| Grid/search projection invariant (single `TEST_SET_UUID`) | `skills/all-test-sets/SKILL.md` | writer subagent `skills` | grid/search generations | (none — progressive disclosure) |
| Domain descriptions (shown to planner) | `src/domain/config.ts` (code-owned) | snapshot tools | planning | n/a — config, not a prompt file |

## Tuning workflow

1. Find the behavior row above, open the `.prompt.md` file.
2. Edit wording. Keep the STRICT JSON / output-shape blocks aligned with the matching
   zod schema in `src/agent/schemas.ts` (planner ↔ `PlannerSchema`,
   writer ↔ `WriterSchema`, checker ↔ `CheckerSchema`) — strict SQL/AST validation
   lives in code and does not change.
3. Tune knobs in frontmatter without code changes: `temperature`, `json_mode`,
   `version`, `description`. Model is always `LLM_MODEL`.
4. Verify: `npm run prompts:check`, then `npm run typecheck` (both no LLM cost).

## Render check (no LLM needed)

```powershell
npx tsx scripts/deep-smoke.ts
```

`deep-smoke` constructs prompts, tools, all 3 subagents, and the agent offline.

## Non-prompt strings (still in code, deliberately)

- Blocked / budget messages in `coordinator.ts` — user-facing copy, not model
  instructions. Move to `prompts/` only if you want copy control.
- `guardrails.ts` error strings — deterministic validator output, asserted by
  tests. Tune only with test updates.
- `response-composer.ts` — no LLM prompt (pure function).
