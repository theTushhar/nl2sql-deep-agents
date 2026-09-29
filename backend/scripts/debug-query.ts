// Temp debug: reproduce the failing /api/query call through the coordinator.
import "dotenv/config";
import { answerQuestion } from "../src/deepagents/coordinator-deep";

async function main(): Promise<void> {
  const result = await answerQuestion({
    echo: { requestId: "debug-1", threadId: "debug-thr-1" },
    question: "give me the test set which contains less than 3 test cases",
    dialect: "mysql",
    domain: "all_test_sets",
    includeAst: true,
  });
  console.log("KIND:", result.kind);
  console.log("TRACE:", result.traceId);
  console.log("ISSUES:", JSON.stringify(result.issues, null, 2));
  console.log("ERROR:", result.envelope.error);
  console.log("SQL:", result.envelope.sql);
  console.log("WARNINGS:", JSON.stringify(result.envelope.warnings));
  console.log("UNRESOLVED:", JSON.stringify(result.envelope.unresolved));
  console.log("META:", JSON.stringify(result.envelope.meta));
  console.log("STAGES:", JSON.stringify(result.envelope.telemetry.tokenCounts));
}

main().catch((err) => {
  console.error("THREW:", err);
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    console.error("STATUS:", e.status);
    console.error("URL:", (e as { url?: unknown }).url ?? (e as { path?: unknown }).path);
    console.error("STACK:", (e as { stack?: unknown }).stack);
  }
  process.exit(1);
});
