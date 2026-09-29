# Evals

## Query evals (live, needs LLM key)

Representative NL questions with expected SQL shapes:

- `query-cases.ts` — THE registry. Add new queries here; the runner picks them
  up with no other changes. Fragments are matched on normalized SQL
  (uppercase, collapsed whitespace), so write `contains`/`notContains`
  UPPERCASE. `tables` asserts the exact FROM/JOIN table set.
- `query-eval.ts` — runs every case through the real coordinator and checks
  kind + SQL fragments + tables + AST + envelope validity. Prints per-case
  PASS/FAIL with LLM calls, tokens, and latency, plus a JSON summary.
  Exit code 1 on any failure.

```powershell
npm run eval:queries
```

Run this after every prompt/subagent change — it catches regressions like
wrong joins, missing filters, broken AST, or contract violations.

## Contract checks (live paths + no-LLM unit paths)

- `contractCheck.ts` — frozen-envelope shape, null-SQL rules, echo mirroring,
  plus live success/blocked/conversational/dialect paths.

```powershell
npm run contract
```

## Golden fixtures + shadow metrics (placeholders)

- `golden/` — per-stage fixtures carried over from earlier backend goldens.
- Promotion requires live-model runs on real representative queries (no mock-only).
