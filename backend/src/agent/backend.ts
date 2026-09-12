import path from "path";
import { FilesystemBackend } from "deepagents";

export function backendRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

export function createAppBackend(): FilesystemBackend {
  return new FilesystemBackend({ rootDir: backendRoot(), virtualMode: true });
}
