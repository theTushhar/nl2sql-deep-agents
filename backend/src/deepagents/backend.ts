// Shared filesystem backend for the deep-agents runtime.
// rootDir = backend root, so virtual paths map 1:1:
//   /skills/...  -> backend/skills/...
//   ./AGENTS.md  -> backend/AGENTS.md
//   /prompts/... -> backend/prompts/...

import path from "path";
import { FilesystemBackend } from "deepagents";

export function backendRoot(): string {
  // src/deepagents/backend.ts -> backend root
  return path.resolve(__dirname, "..", "..");
}

export function createAppBackend(): FilesystemBackend {
  return new FilesystemBackend({ rootDir: backendRoot(), virtualMode: true });
}
