// Deep Agents runtime singleton. Wiring only — all wording lives in
// prompts/*.prompt.md (coordinator) and skills/*/SKILL.md.
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { resolveModelId } from "./model";
import { buildSubagents } from "./subagents";
import { FinalAnswerResponse, finalAnswerTool } from "./schemas";
import { createAppBackend } from "./backend";
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
    // Literally-named terminal tool: toolStrategy's synthetic name
    // (extract-N) is invisible to prompts, so the coordinator gets a
    // directly-callable `FinalAnswer` (see schemas.ts). Dispatcher-only
    // otherwise: the coordinator never reads skills directly.
    tools: [finalAnswerTool],
    skills: [],
    memory: ["./AGENTS.md"],
    backend,
    // read_file only (skill L2 reads). Same-name entry replaces the default
    // FilesystemMiddleware; also avoids the OpenAI strict-schema `glob` issue.
    middleware: [
      createFilesystemMiddleware({ backend, tools: ["read_file"] }),
      createLlmCallLimit("coordinator", DEFAULT_COORDINATOR_LLM_CALL_LIMIT),
    ],
    // No writes anywhere; no reads of secrets, deps, build output, or source.
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

/** For tests: reset the singleton so config changes take effect. */
export function resetDeepAgent(): void {
  cached = null;
}
