// Temp debug: invoke the deep agent directly to surface the raw provider error.
import "dotenv/config";
import { getDeepAgent, resetDeepAgent } from "../src/deepagents/agent";

async function main(): Promise<void> {
  resetDeepAgent();
  const agent = await getDeepAgent();
  const result = await agent.invoke(
    { messages: [{ role: "user", content: "Say hello in one word." }] },
    { configurable: { thread_id: "debug-direct-1" } }
  );
  console.log("OK:", JSON.stringify(result).slice(0, 500));
}

main().catch((err) => {
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 12) {
    const e = cur as Record<string, unknown>;
    console.error(
      `--- depth ${depth} [${(cur as Error)?.name ?? typeof cur}]`,
      JSON.stringify({
        message: (cur as Error)?.message,
        status: e.status,
        code: e.code,
        type: e.type,
        url: e.url,
        path: e.path,
        method: e.method,
      })
    );
    cur = (cur as Error)?.cause;
    depth++;
    if (!cur) break;
  }
  console.error("STACK:", err instanceof Error ? err.stack : "n/a");
  process.exit(1);
});
