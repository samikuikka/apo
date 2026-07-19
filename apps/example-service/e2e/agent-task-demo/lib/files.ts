/**
 * Load a task's files into a `relativePath → contents` map.
 *
 * Shared by the in-process adapters (`ai-sdk`, `real-agent`) because both
 * hand the same map to `handleChat`. The Claude adapter does NOT use this —
 * it points the SDK at a real `files/` cwd instead.
 */
import { readFileSync } from "fs";
import type { FileEntry } from "@apo/sdk/agent-task";

export function loadFiles(files: FileEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f.relativePath] = readFileSync(f.absolutePath, "utf-8");
  return out;
}
