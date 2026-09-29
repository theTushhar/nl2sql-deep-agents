# PROMPTMAP — prompt tuning index

All LLM wording lives in `prompts/*.prompt.md`. **To tune any behavior, edit the
`.prompt.md` file only — never `src/deepagents/subagents.ts`.** Each prompt body
becomes a subagent `systemPrompt` (placeholders resolve via tools + task
description at runtime). Single model: `LLM_MODEL` for everything (subagents
inherit; per-prompt `model_env` is informational).

Self-service rules:
- Each prompt is an isolated subagent with its own context window. The main agent
  passes only task-scoped facts in the `task` description (question, domain,
  tables, filters, catalog text, time context) — never full transcripts.
- Subagent outputs are zod-`responseFormat` enforced (`src/deepagents/schemas.ts`);
  strict re-validation of SQL/AST stays in code (`coordinator-deep.ts`).
- Run `npm run prompts:check` after editing (no LLM cost).

See `AGENTS.md` §5 for the workflow and `docs/deep-agents.md` for the full reference.

## Map

| Tune this behavior | Edit this file | Owner (do not edit for wording) | Runs | Facts (via tools / task description) |
|---|---|---|---|---|
| Safety / intent classification, blocked language | `prompts/input-guard.prompt.md` | `src/deepagents/subagents.ts` (`input-guard`) | 1st gate, every request | question only |
| Greeting handling, tone, normalization, synonyms (domain-agnostic, never decides domain) | `prompts/query-normalizer.prompt.md` | `src/deepagents/subagents.ts` (`query-normalizer`) | 2nd gate, every allowed request | question only |
| Domain routing rules (which intent → which domain; runs only for default/unpinned requests, pinned domains skip it) | `prompts/domain-router.prompt.md` | `src/deepagents/subagents.ts` (`domain-router`) | after normalize, only when unpinned | `list_domains` tool |
| Domain rephrase + intent re-review under the resolved domain's projection contract | `prompts/domain-rephraser.prompt.md` | `src/deepagents/subagents.ts` (`domain-rephraser`) | after domain resolution, every allowed request | `canonical_query, domain, projection_policy` in task description + `list_domains` tool |
| Table relevance, search scope, LIKE patterns, complexity | `prompts/schema-explorer.prompt.md` | `src/deepagents/subagents.ts` (`schema-explorer`) | after routing | snapshot tools (`find_tables`, `get_table_schema`, `list_searchable_columns`) |
| Business-rule selection, measures/dimensions/orderBy | `prompts/business-rules.prompt.md` | `src/deepagents/subagents.ts` (`business-rules`) | after explore | `list_business_rules` tool |
| SQL generation rules (schema use, aliases, LIKE, projection, LIMIT, output shape) | `prompts/sql-writer.prompt.md` | `src/deepagents/subagents.ts` (`sql-writer`) | every generation attempt | `build_schema_block` + measures/filters/orderBy/critique in description |
| SQL validation constraints, JSON verdict schema | `prompts/sql-critic.prompt.md` | `src/deepagents/subagents.ts` (`sql-critic`) | after every writer attempt | candidate SQL + domain in description |
| AST v2 derivation from certified SQL (generic, no domain branches; mirrors SQL projection/tables/joins, SQL↔AST table agreement enforced in code) | `prompts/ast-generator.prompt.md` | `src/deepagents/subagents.ts` (`ast-generator`) | after SQL certification, on success only when `include_ast=true` | certified SQL + catalog text + required tables + search spec + filters + time context in description |
| User-facing copy pack (no LLM cost, pure template) | `prompts/response-composer.prompt.md` | `src/orchestration/response-composer.ts` (`composeResponse`) | every terminal path | `question, tables, dialect, intent` |
| Generation style: read-only, aliases, JOINs, projection guidance | `skills/general/query-writing/SKILL.md` | writer subagent `skills` | every generation | (none — progressive disclosure) |
| Grid/search projection invariant (single `TEST_SET_UUID`) | `skills/domains/all-test-sets/SKILL.md` | writer subagent `skills` | grid/search generations | (none — progressive disclosure) |
| Retry-repair guidance | `skills/critic/query-critic/SKILL.md` | critic subagent `skills` | validation + retries | (none — progressive disclosure) |
| Domain routing descriptions (shown to router + normalizer) | `src/config/domain-config.ts` (code-owned) | snapshot tools | routing/classification | n/a — config, not a prompt file |

## Tuning workflow

1. Find the behavior row above, open the `.prompt.md` file.
2. Edit wording. Keep the STRICT JSON / output-shape blocks aligned with the matching
   zod schema in `src/deepagents/schemas.ts` (boundary) — strict SQL/AST validation
   lives in code and does not change.
3. Tune knobs in frontmatter without code changes: `temperature`, `json_mode`,
   `version`, `description`. Model is always `LLM_MODEL`.
4. Verify: `npm run prompts:check`, then `npm run typecheck` (both no LLM cost).

## Render check (no LLM needed)

```powershell
npx tsx scripts/deep-smoke.ts
```

`deep-smoke` constructs prompts, tools, all 9 subagents, and the agent offline.

## Non-prompt strings (still in code, deliberately)

- Blocked / budget messages in `coordinator-deep.ts` — user-facing copy, not model
  instructions. Move to `prompts/` only if you want copy control.
- `sql-guardrails.ts` error strings — deterministic validator output, asserted by
  tests. Tune only with test updates.
- `response-composer.ts` — no LLM prompt (pure function).
