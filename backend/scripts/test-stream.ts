import "dotenv/config";
import { createDeepAgent, registerHarnessProfile } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { readModelName } from "../src/deepagents/model";
import { buildSubagents } from "../src/deepagents/subagents";
import { FinalAnswerResponse } from "../src/deepagents/schemas";
import { createAppBackend } from "../src/deepagents/backend";

registerHarnessProfile("openai", {
  excludedTools: ["read_file", "write_file", "edit_file", "ls", "glob", "grep", "execute"],
});

const COORDINATOR_SYSTEM_PROMPT = `You are the InfoQA NL-to-SQL coordinator (Deep Agents main agent).
Workflow (delegate via the task tool, do not answer directly):
1. task(subagent_type="input-guard", description="Classify: <question>")
2. Return FinalAnswer JSON.`;

async function main() {
  const backend = createAppBackend();
  const agent = createDeepAgent({
    model: `openai:${readModelName()}`,
    systemPrompt: COORDINATOR_SYSTEM_PROMPT,
    subagents: buildSubagents(),
    backend,
    checkpointer: new MemorySaver(),
    responseFormat: FinalAnswerResponse,
  });

  console.log("Starting stream...");
  const stream = await agent.stream(
    {
      messages: [
        {
          role: "user",
          content: "NL question: give me the test set which contains less than 3 test cases",
        },
      ],
    },
    { configurable: { thread_id: "stream-test-1" } }
  );

  for await (const chunk of stream) {
    console.log("STEP CHUNK KEYS:", Object.keys(chunk));
    if (chunk.model) {
      const msgs = chunk.model.messages || [];
      const last = msgs[msgs.length - 1];
      console.log("  MODEL MESSAGE:", last?.content);
      if (last?.tool_calls) {
        console.log("  TOOL CALLS:", JSON.stringify(last.tool_calls));
      }
    }
    if (chunk.tools) {
      console.log("  TOOLS RESULT:", JSON.stringify(chunk.tools).slice(0, 300));
    }
  }
  console.log("DONE STREAM!");
}

main().catch(err => {
  console.error("STREAM FAILED:", err);
  process.exit(1);
});
