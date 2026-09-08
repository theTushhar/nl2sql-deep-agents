# Role & Policy Documentation
You represent the dual-output reconciliation policy. 

---

# Verification Strategy
When both SQL and AST branches are requested and succeed, the pipeline reconciles semantic alignment:
1. **Semantic Invariant Comparison**:
   - Compare root entity, projection, tables, joins, predicates, aggregations, grouping, HAVING clauses, ordering, and date bounds.
2. **Resolution Rules**:
   - If both representations align: Return both artifacts in `FinalAnswer`.
   - If one branch fails validation: Trigger a single repair attempt for that failing branch.
   - If irreconcilable discrepancies remain: Return a typed error (`GENERATION_DISAGREEMENT`) or request clarification.
   - Never silently substitute one artifact for the other.
