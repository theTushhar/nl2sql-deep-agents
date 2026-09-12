import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { resolveModelId } from "./model";
import { buildSubagents, STAGE_BUDGETS } from "./subagents";
import { FinalAnswerResponse, finalAnswerTool } from "./schemas";
import { PlannerResponse, SqlWriterResponse, AstWriterResponse } from "./schemas";
import { createAppBackend } from "./backend";
import { snapshotTools } from "./tools";
import { createLlmCallLimit, DEFAULT_COORDINATOR_LLM_CALL_LIMIT } from "./limits";
import { loadStagePrompt } from "./prompts";

let cached: Awaited<ReturnType<typeof createDeepAgent>> | null = null;

export async function getDeepAgent(): Promise<NonNullable<typeof cached>> {
  if (cached) return cached;
  const backend = createAppBackend();
  const params = {
    model: resolveModelId(),
    systemPrompt: loadStagePrompt("coordinator"),
    subagents: buildSubagents(),
    tools: [finalAnswerTool],
    skills: [],
    memory: [],
    backend,
    middleware: [
      createFilesystemMiddleware({ backend, tools: ["read_file"] }),
      createLlmCallLimit("coordinator", DEFAULT_COORDINATOR_LLM_CALL_LIMIT),
    ],
    permissions: [
      { operations: ["write"], paths: ["/**"], mode: "deny" },
      {
        operations: ["read"],
        paths: [
          "/.env",
          "/.env.*",
          "/node_modules/**",
          "/dist/**",
          "/src/**",
          "/tests/**",
          "/scripts/**",
          "/conversation_history/**",
        ],
        mode: "deny",
      },
    ],
    checkpointer: new MemorySaver(),
    responseFormat: FinalAnswerResponse,
  } as unknown as Parameters<typeof createDeepAgent>[0];
  const agent = await createDeepAgent(params);
  cached = agent as NonNullable<typeof cached>;
  return cached;
}

export function resetDeepAgent(): void {
  cached = null;
  branchAgents = null;
}

const BRANCH_DEFS = [
  {
    stage: "planner",
    responseFormat: PlannerResponse,
    tools: ["get_table_schema", "list_searchable_columns", "list_business_rules", "get_allowed_values", "build_schema_block"],
    skills: [] as string[],
  },
  {
    stage: "sql-writer",
    responseFormat: SqlWriterResponse,
    tools: [
      "find_tables",
      "get_table_schema",
      "list_searchable_columns",
      "list_business_rules",
      "get_allowed_values",
      "build_schema_block",
      "get_context",
    ],
    skills: ["/skills/"],
  },
  {
    stage: "ast-writer",
    responseFormat: AstWriterResponse,
    tools: ["get_context", "get_table_schema", "list_business_rules", "build_schema_block"],
    skills: ["/skills/"],
  },
] as const;

export type BranchStage = (typeof BRANCH_DEFS)[number]["stage"];

let branchAgents: Record<BranchStage, Awaited<ReturnType<typeof createDeepAgent>>> | null = null;
const branchCheckpointer = new MemorySaver();

function branchTools(names: readonly string[]): typeof snapshotTools {
  return snapshotTools.filter((t) => (names as readonly string[]).includes((t as { name: string }).name));
}

export async function getBranchAgent(
  stage: BranchStage
): Promise<Record<BranchStage, Awaited<ReturnType<typeof createDeepAgent>>>[BranchStage]> {
  if (!branchAgents) {
    const backend = createAppBackend();
    const built = {} as Record<BranchStage, Awaited<ReturnType<typeof createDeepAgent>>>;
    for (const def of BRANCH_DEFS) {
      const tools = branchTools(def.tools);
      const params = {
        model: resolveModelId(),
        systemPrompt: loadStagePrompt(def.stage),
        tools,
        responseFormat: def.responseFormat,
        skills: [...def.skills],
        backend,
        middleware: [
          createFilesystemMiddleware({ backend, tools: ["read_file"] }),
          createLlmCallLimit(def.stage, STAGE_BUDGETS[def.stage] ?? 6),
        ],
        checkpointer: branchCheckpointer,
      } as unknown as Parameters<typeof createDeepAgent>[0];
      built[def.stage as BranchStage] = (await createDeepAgent(params)) as never;
    }
    branchAgents = built;
  }
  return branchAgents[stage];
}
