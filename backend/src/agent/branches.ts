import { z } from "zod";
import { getBranchAgent, type BranchStage } from "./agent";
import { PlannerSchema, SqlWriterSchema, AstWriterSchema } from "./schemas";
import { loadStagePrompt } from "./prompts";
import { asObject } from "./final-answer-helper";
import { validatePlan, filterRulesByQuestion, type ValidatedPlan, type PlanKind } from "./plan-validator";

export { validatePlan, filterRulesByQuestion };
export type { ValidatedPlan, PlanKind, BranchStage };

export interface BranchCallOpts {
  requestId: string;
  threadId: string;
  branchTag: string;
  signal?: AbortSignal;
  recorder?: unknown;
  langfuseCallback?: unknown;
  runName?: string;
  tags?: string[];
}

export function buildSqlContract(plan: ValidatedPlan, dialect: string, timeText: string): string {
  const fields = plan.selectedFields.map((f) => ({ entity: f.entity, field: f.field }));
  return JSON.stringify({
    q: plan.canonicalQuery,
    d: plan.domain,
    t: plan.relevantEntities,
    fields,
    rules: plan.appliedRuleIds,
    dialect,
    time: timeText,
  });
}

export function buildAstContract(plan: ValidatedPlan, timeText: string): string {
  const fields = plan.selectedFields.map((f) => ({ entity: f.entity, field: f.field }));
  return JSON.stringify({
    q: plan.canonicalQuery,
    d: plan.domain,
    t: plan.relevantEntities,
    fields,
    rules: plan.appliedRuleIds,
    requiredProjection: plan.requiredProjection,
    time: timeText,
  });
}

function messageTextOf(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
          return (c as { text: string }).text;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function toolCallArgsOf(msg: unknown): unknown[] {
  if (!msg || typeof msg !== "object") return [];
  const calls = (msg as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(calls)) {
    return calls.map((c: unknown) => (c && typeof c === "object" ? (c as { args?: unknown }).args : undefined));
  }
  return [];
}

export function extractBranchJson(result: unknown, keys: string[]): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const res = result as Record<string, unknown>;
  const direct = asObject(res.structuredResponse);
  if (direct && keys.every((k) => k in direct)) return direct;

  const messages = res.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      for (const args of toolCallArgsOf(messages[i])) {
        const obj = asObject(args);
        if (obj && keys.every((k) => k in obj)) return obj;
      }
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const obj = asObject(messageTextOf(messages[i]));
      if (obj && keys.every((k) => k in obj)) return obj;
    }
  }
  return direct;
}

const plannerKeys = ["kind", "canonicalQuery", "domain"];
const sqlKeys = ["kind", "sql", "tablesUsed"];
const astKeys = ["kind", "ast", "tablesUsed"];

function invokeConfigFor(opts: BranchCallOpts, threadId: string): Record<string, unknown> {
  return {
    configurable: { thread_id: threadId },
    recursionLimit: 80,
    ...(opts.signal ? { signal: opts.signal } : {}),
    runName: opts.runName ?? `branch-${opts.branchTag}`,
    tags: opts.tags ?? ["deep-agents", "nl2sql", opts.branchTag],
    ...(opts.langfuseCallback
      ? { callbacks: [opts.langfuseCallback, ...(opts.recorder ? [opts.recorder] : [])] }
      : opts.recorder
        ? { callbacks: [opts.recorder] }
        : {}),
  };
}

export type PlannerResult = z.infer<typeof PlannerSchema>;
export type SqlWriterResult = z.infer<typeof SqlWriterSchema>;
export type AstWriterResult = z.infer<typeof AstWriterSchema>;
export type BranchResult<T> = { data: T } | { error: string };

export async function runPlannerBranch(
  message: string,
  opts: BranchCallOpts
): Promise<BranchResult<PlannerResult>> {
  try {
    const agent = await getBranchAgent("planner");
    const result = (await agent.invoke(
      { messages: [{ role: "user", content: message }] },
      invokeConfigFor(opts, `${opts.threadId}:${opts.requestId}:planner`)
    )) as unknown;
    const json = extractBranchJson(result, plannerKeys);
    if (!json) return { error: "Planner returned no parseable plan." };
    const parsed = PlannerSchema.safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { error: `Planner output failed validation: ${detail}` };
    }
    return { data: parsed.data };
  } catch (err) {
    return { error: `Planner branch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runWriterBranch(
  stage: "sql-writer" | "ast-writer",
  message: string,
  opts: BranchCallOpts
): Promise<BranchResult<SqlWriterResult | AstWriterResult>> {
  try {
    const agent = await getBranchAgent(stage);
    const result = (await agent.invoke(
      { messages: [{ role: "user", content: message }] },
      invokeConfigFor(opts, `${opts.threadId}:${opts.requestId}:${stage}`)
    )) as unknown;
    const schema = stage === "sql-writer" ? SqlWriterSchema : AstWriterSchema;
    const keys = stage === "sql-writer" ? sqlKeys : astKeys;
    const json = extractBranchJson(result, keys);
    if (!json) return { error: `${stage} returned no parseable output.` };
    const parsed = (schema as typeof SqlWriterSchema).safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { error: `${stage} output failed validation: ${detail}` };
    }
    return { data: parsed.data as SqlWriterResult | AstWriterResult };
  } catch (err) {
    return { error: `${stage} branch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function repairPrefix(stage: "sql-writer" | "ast-writer"): string {
  return loadStagePrompt(stage === "sql-writer" ? "sql-repair" : "ast-repair");
}
