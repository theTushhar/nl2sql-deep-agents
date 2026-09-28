// Certification gate + writer/critic retry loop.
// The ONLY path by which SQL leaves the ecosystem: the coordinator never
// authors SQL, it only passes through what this gate certifies. Budget:
// at most MAX_ROUNDS writer+critic rounds (2–3, confirmed). Exhaustion
// returns an error result — never uncertified SQL.

import type { ConfigSnapshot } from "../config/domain-config";
import type { TriggerRecord } from "../tools/snapshot-tools";
import { writeSql, type WriterInput } from "../agents/sql-writer.agent";
import { critiqueSql } from "../agents/sql-critic.agent";

/** Confirmed retry budget: writer-plus-critic capped at 2–3 rounds. */
export const MAX_ROUNDS = 3;

export interface CertifyInput extends Omit<WriterInput, "critique" | "attempt"> {
  snapshot: ConfigSnapshot;
}

export interface CertifiedResult {
  certified: boolean;
  sql: string | null;
  attempts: number;
  errors: string[];
  warnings: string[];
  unresolved: string[];
  skills: string[];
  triggers: TriggerRecord[];
  costUsd: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

function resolveEffectiveTables(snapshot: ConfigSnapshot, domain: string, relevantTables: string[]): string[] {
  const entry = snapshot.domains.find((d) => d.canonical_name.toLowerCase() === domain.toLowerCase());
  const allowed = entry?.allowedTables ?? [];
  // Domains with explicit allowedTables (e.g. all_test_sets) must keep the
  // full domain scope for writer schema + critic whitelist. Explorer narrows
  // to a minimal relevantTables subset, which alone cannot satisfy domain
  // invariants like SELECT DISTINCT ts.TEST_SET_UUID (needs TEST_SET join).
  // Default domain has allowedTables=[] meaning "all tables": keep intent subset.
  if (allowed.length === 0) return relevantTables;
  const ordered = [...allowed];
  for (const t of relevantTables) {
    if (!ordered.includes(t)) ordered.push(t);
  }
  return ordered;
}

export async function certifySql(input: CertifyInput): Promise<CertifiedResult> {
  const effectiveTables = resolveEffectiveTables(input.snapshot, input.domain, input.relevantTables);
  const allowedBinds: string[] = [];
  const bindRe = /:(APP_LOGGED_IN_[A-Z0-9_]+)/gi;
  for (const filter of input.filters) {
    let m: RegExpExecArray | null;
    while ((m = bindRe.exec(filter)) !== null) {
      if (m[1] && !allowedBinds.includes(`:${m[1].toUpperCase()}`)) {
        allowedBinds.push(`:${m[1].toUpperCase()}`);
      }
    }
  }

  let critique = "";
  let costUsd = 0;
  let latencyMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const triggers: TriggerRecord[] = [];
  let skills: string[] = [];
  let lastSql = "";
  let warnings: string[] = [];
  let unresolved: string[] = [];
  let errors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ROUNDS; attempt++) {
    const written = await writeSql({ ...input, relevantTables: effectiveTables, critique, attempt });
    costUsd += written.costUsd;
    latencyMs += written.latencyMs;
    tokensIn += written.tokensIn;
    tokensOut += written.tokensOut;
    triggers.push(...written.triggers);
    skills = written.skills;
    lastSql = written.sql;

    const judged = await critiqueSql({
      sql: written.sql,
      canonical_query: input.canonical_query,
      domain: input.domain,
      dialect: input.dialect,
      relevantTables: effectiveTables,
      allowedBinds,
      complexity: input.complexity,
      snapshot: input.snapshot,
    });
    costUsd += judged.costUsd;
    latencyMs += judged.latencyMs;
    tokensIn += judged.tokensIn;
    tokensOut += judged.tokensOut;
    warnings = judged.warnings;
    unresolved = judged.unresolved;
    errors = judged.errors;

    if (judged.valid) {
      return {
        certified: true,
        sql: written.sql,
        attempts: attempt,
        errors: [],
        warnings,
        unresolved,
        skills,
        triggers,
        costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    }
    critique = judged.critique;
  }

  return {
    certified: false,
    sql: null,
    attempts: MAX_ROUNDS,
    errors,
    warnings,
    unresolved,
    skills,
    triggers,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    latencyMs,
    tokensIn,
    tokensOut,
  };
}
