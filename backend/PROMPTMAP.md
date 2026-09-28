# PROMPTMAP — prompt tuning index

All LLM prompt text lives in `prompts/*.prompt.md`. **To tune any prompt, edit the
`.prompt.md` file only — never the `.agent.ts` owner.** Code computes
`{{variables}}`; files hold words. Prompt filename MUST match its agent file:
`prompts/<stage>.prompt.md` ↔ `src/agents/<stage>.agent.ts`.

See `AGENTS.md` §5 for the full Deep Agents-aligned workflow.

## Map

| Tune this behavior | Edit this file | Owner (do not edit for wording) | Runs | Variables (computed in code) |
|---|---|---|---|---|
| Safety / intent classification, blocked language | `prompts/input-guard.prompt.md` | `src/agents/input-guard.agent.ts` (`analyzeGuardrail`) | 1st gate, every request | `snapshot_ref, min_length, max_length, blocked_keywords, allowed_intents, blocked_intents` |
| Greeting handling, tone, normalization, synonyms, pre-domain | `prompts/query-normalizer.prompt.md` | `src/agents/query-normalizer.agent.ts` (`normalizeQuery`) | 2nd gate, every allowed request | `domain_list` |
| Domain routing rules (which intent → which domain) | `prompts/domain-router.prompt.md` | `src/agents/domain-router.agent.ts` (`routeDomain`) | after normalize | `domain_list` |
| Table relevance, search scope, LIKE patterns, complexity | `prompts/schema-explorer.prompt.md` | `src/agents/schema-explorer.agent.ts` (`exploreSchema`) | after routing | `schema_facts, searchable_columns, domain` |
| Business-rule selection, measures/dimensions/orderBy | `prompts/business-rules.prompt.md` | `src/agents/business-rules.agent.ts` (`interpretRules`) | after explore | `rule_list` |
| SQL generation rules (schema use, aliases, LIKE, projection, LIMIT, output shape) | `prompts/sql-writer.prompt.md` | `src/agents/sql-writer.agent.ts` (`writeSql`) | every generation attempt | `domain, schema_block, search_scope, search_guidance, measures, filters, order_by, feedback_section, skill_block` |
| SQL validation constraints, JSON verdict schema | `prompts/sql-critic.prompt.md` | `src/agents/sql-critic.agent.ts` (`critiqueSql`) | after every writer attempt | `column_whitelist, relevant_tables, allowed_binds` |
| Generation style: read-only, aliases, JOINs, projection guidance | `skills/general/query-writing/SKILL.md` | layered into writer via `src/skills/skill-loader.ts` | every generation | (none — static pack) |
| Grid/search projection invariant (single `TEST_SET_UUID`) | `skills/domains/all-test-sets/SKILL.md` | layered into writer when domain = `all_test_sets` | grid/search generations | (none — static pack) |
| Retry-repair guidance | `skills/critic/query-critic/SKILL.md` | layered into writer from retry attempt 2+ | retries | (none — static pack) |
| Domain routing descriptions (shown to router + normalizer) | `src/config/domain-config.ts` (code-owned) | `routeDomain`, `normalizeQuery` | routing/classification | n/a — config, not a prompt file |

## Tuning workflow

1. Find the behavior row above, open the `.prompt.md` file.
2. Edit wording. Keep `{{variables}}` intact; keep STRICT JSON schemas byte-identical
   unless you also update the parser in the owner `.agent.ts` file.
3. Verify: `npm run typecheck`, then render-check below (no LLM cost).

## Render check (no LLM needed)

```powershell
npx tsx -e "import('./src/prompting/template-loader.ts').then(async (m) => { console.log('template-loader OK') })"
```

Every `{{variable}}` in frontmatter must be supplied by the owner — missing ones
render as empty.

## Non-prompt strings (still in code, deliberately)

- `input-guard.agent.ts` budget-gate rejections + `FORMAL_BLOCK_MESSAGE` — user-facing
  copy, not model instructions. Move to `prompts/` only if you want copy control.
- `sql-guardrails.ts` error strings — deterministic validator output, asserted by
  tests. Tune only with test updates.
- `response-composer.ts` — no LLM prompt (pure function).
