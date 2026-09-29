# Skills (Deep Agents progressive disclosure packs)

Flat structure adhering to official Deep Agents standard (`skills/<skill-name>/SKILL.md`).
One skill per domain; the generic writer prompt carries mechanics, skills carry
projection invariants:

- `default-reporting/` — Flexible multi-column analytical reporting for the `default` domain (counts, groupings, orderings, ad-hoc reports).
- `all-test-sets/` — Domain-specific UI grid filter subquery generation (`SELECT DISTINCT ts.TEST_SET_UUID`).

Skills load metadata at startup and full instructions on demand via `read_file`.
