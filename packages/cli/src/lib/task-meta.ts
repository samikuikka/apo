import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { listTaskCandidateDirs, type ScanOptions } from "./scanner.ts";
import type { TaskExecutionPreference } from "@apo/sdk/agent-task";

export type TaskMeta = {
  id: string;
  adapter: string;
  hasChecks: boolean;
  hasSimulator: boolean;
  path: string;
  deliverables: string[];
  files: string[];
  /**
   * The task's declared execution preference (SPEC-136), read statically
   * from the `.eval.ts` file. `undefined` when absent or `"auto"` — both
   * mean "no preference, defer to project default / reachability". Read
   * without loading the task module so we don't pay for double registration
   * of checks at dispatch time.
   */
  execution?: TaskExecutionPreference;
};

export type DiscoverOptions = Omit<ScanOptions, "rootDir">;

export function discoverTaskMeta(
  rootDir: string,
  options?: DiscoverOptions,
): TaskMeta[] {
  const candidates = listTaskCandidateDirs({ rootDir, ...options });
  const results: TaskMeta[] = [];

  for (const taskDir of candidates) {
    const meta = parseTaskMeta(taskDir);
    if (meta) {
      results.push(meta);
    }
  }

  return results;
}

export function findTaskMetaById(
  rootDir: string,
  taskId: string,
): TaskMeta | undefined {
  const tasks = discoverTaskMeta(rootDir);
  return tasks.find((t) => t.id === taskId);
}

function parseTaskMeta(taskDir: string): TaskMeta | undefined {
  const evalFile = readdirSync(taskDir).find((f) => f.endsWith(".eval.ts"));
  if (!evalFile) {
    return undefined;
  }
  const taskFilePath = join(taskDir, evalFile);

  const content = readFileSync(taskFilePath, "utf-8");
  const id = extractTaskId(content);
  if (!id) {
    return undefined;
  }

  const adapter = extractAdapter(content) ?? "unknown";

  const deliverables = extractArrayField(content, "deliverables");
  const hasChecks = extractHasChecks(content, taskDir);
  const hasSimulator = /simulator\s*:/.test(content);
  const execution = extractExecution(content);

  const filesDir = join(taskDir, "files");
  const files: string[] = [];
  if (existsSync(filesDir) && statSync(filesDir).isDirectory()) {
    for (const f of readdirSync(filesDir)) {
      files.push(f);
    }
  }

  return {
    id,
    adapter,
    hasChecks,
    hasSimulator,
    path: taskDir,
    deliverables,
    files,
    execution,
  };
}

function extractStringField(content: string, field: string): string | null {
  const doubleQuoteRegex = new RegExp(`${field}\\s*:\\s*"([^"]*)"`);
  const match = content.match(doubleQuoteRegex);
  if (match) return match[1];

  const singleQuoteRegex = new RegExp(`${field}\\s*:\\s*'([^']*)'`);
  const match2 = content.match(singleQuoteRegex);
  if (match2) return match2[1];

  return null;
}

function extractTaskId(content: string): string | null {
  // New API: task("name", ...)
  const taskMatch = content.match(/\btask\(\s*["']([^"']+)["']/);
  if (taskMatch) return taskMatch[1];
  // Legacy: id: "name" inside defineTask config
  return extractStringField(content, "id");
}

function extractAdapter(content: string): string | null {
  // New API: adapter: someAdapter (identifier inside config). Capture an
  // optional opening paren so factory calls like `adapter: createXxxAdapter(y)`
  // are shown honestly as `createXxxAdapter(...)` — the scanner can't load the
  // module to resolve the runtime adapter.name, but the parens make it obvious
  // the displayed identifier is a factory, not the adapter itself.
  const adapterProp = content.match(/\badapter\s*:\s*(\w+)(\()?/);
  if (adapterProp) {
    return adapterProp[2] ? `${adapterProp[1]}(...)` : adapterProp[1];
  }
  // Legacy explicit adapter names take precedence over the defineTask variable.
  const adapterName = extractStringField(content, "adapter");
  if (adapterName) return adapterName;
  // Legacy: defineTask(someAdapter, ...)
  const defineTaskMatch = content.match(/defineTask\(\s*(\w+)/);
  if (defineTaskMatch) return defineTaskMatch[1];
  return null;
}

function extractHasChecks(content: string, taskDir: string): boolean {
  // Checks are inline (check( / test( calls in the .eval.ts file itself)
  if (/\bcheck\s*\(|\btest\s*\(/.test(content)) return true;
  // Legacy: separate checks.ts file
  return existsSync(join(taskDir, "checks.ts"));
}

function extractArrayField(content: string, field: string): string[] {
  const regex = new RegExp(`${field}\\s*:\\s*\\[([^\\]]+)\\]`);
  const match = content.match(regex);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, ""),
    )
    .filter(Boolean);
}

/**
 * Read a task's `execution` preference statically (SPEC-136). Mirrors the
 * other `extract*` helpers so `task-run` can pick a dispatch mode without
 * executing the user's module (which would re-register checks). Strips `//`
 * line comments first so a documented example doesn't get mistaken for a
 * real declaration. `"auto"` and unknown values collapse to `undefined`
 * (== "no preference"), matching the semantics of `resolveExecutionMode`.
 */
function extractExecution(content: string): TaskExecutionPreference | undefined {
  const withoutComments = content.replace(/^[ \t]*\/\/.*$/gm, "");
  const value = extractStringField(withoutComments, "execution");
  if (value === "local" || value === "backend") return value;
  return undefined;
}
