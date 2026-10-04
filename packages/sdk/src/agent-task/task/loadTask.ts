import { copyFileSync, readdirSync, statSync, existsSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve, basename } from "path";
import { pathToFileURL } from "url";
import type { AdapterDefinition } from "../adapter/types.ts";
import { getTaskAdapterDefinition, getRegisteredTask, resetTaskRegistry } from "./defineTask.ts";
import { resetFlowChecks } from "../checks/flow-runner.ts";
import { validateMcpServerConfig } from "../checks/mcp-tools.ts";
import { resetTaskTurn } from "../turn.ts";
import { resetTaskSteers } from "../steer.ts";
import type { TaskDefinition, FileEntry } from "./types.ts";

export type LoadedTask = {
  task: TaskDefinition;
  adapter: AdapterDefinition;
  taskDir: string;
  files: FileEntry[];
  /** Legacy external checks module, absent for single-file tasks. */
  checksPath: string | null;
  /** True when task(), test(), and turn() were registered by the eval file. */
  inlineChecks: boolean;
  /** The temp-module URL the task was imported from (used for location pinning). */
  moduleUrl: string;
  /** The original eval filename (e.g. "code-review.eval.ts") — used as source_file on check results. */
  evalFileName: string;
};

export async function loadTask(taskDir: string): Promise<LoadedTask> {
  const absoluteDir = resolve(taskDir);
  const taskFilePath = findEvalFile(absoluteDir);

  if (!taskFilePath) {
    throw new Error(`No .eval.ts file found in: ${absoluteDir}`);
  }

  const { task, adapter, inlineChecks, moduleUrl } =
    await loadTaskDefinition(taskFilePath);
  validateTaskDefinition(task, absoluteDir);

  const files = loadFilesDirectory(absoluteDir);
  const checksPath = resolveChecksPath(task, absoluteDir);

  return {
    task,
    adapter,
    taskDir: absoluteDir,
    files,
    checksPath,
    inlineChecks,
    moduleUrl,
    evalFileName: basename(taskFilePath),
  };
}

/**
 * Materialize and load an eval from stored source text (issue #159 rejudge).
 *
 * Writes `content` as a temp sibling inside `siblingDir` (a real task
 * directory, so relative imports and `files/` fixtures resolve like a live
 * run) or inside `isolatedDir` (self-contained evals only — a scaffold next
 * to the SDK so package imports resolve). The stored revision pins only the
 * eval file itself; when a sibling dir is unavailable, evals that import
 * sibling modules cannot replay and fail with a guided error.
 */
export async function loadEvalSource(
  fileName: string,
  content: string,
  opts: { siblingDir?: string | null; isolatedDir?: string | null } = {},
): Promise<LoadedTask> {
  const dir = opts.siblingDir ?? opts.isolatedDir;
  if (!dir) {
    throw new Error("loadEvalSource requires a siblingDir or isolatedDir to materialize next to");
  }
  const tempPath = join(
    dir,
    `${fileName}.rejudge-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
  );
  writeFileSync(tempPath, content);
  try {
    const { task, adapter, inlineChecks, moduleUrl } = await loadTaskDefinition(tempPath);
    validateTaskDefinition(task, dir);
    if (!inlineChecks && !existsSync(join(dir, "checks.ts"))) {
      throw new Error(
        `The pinned eval did not register checks: legacy two-file tasks need their checks module, ` +
          `which the stored definition revision does not include`,
      );
    }
    return {
      task,
      adapter,
      taskDir: dir,
      files: loadFilesDirectory(dir),
      checksPath: resolveChecksPath(task, dir),
      inlineChecks,
      moduleUrl,
      evalFileName: fileName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!opts.siblingDir && /Failed to load task definition/.test(message)) {
      throw new Error(
        `Replay needs the task directory: the pinned eval imports sibling files that are not ` +
          `part of the stored definition revision. Point the command at a checkout of the task ` +
          `(--task-dir) and retry. Underlying error: ${message}`,
      );
    }
    throw error;
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

/**
 * Import the task file as a temp module. The side-effect of importing
 * registers the task (via `task()`), all checks (via `check()`/`test()`),
 * and any turn override (via `turn()`) — all from ONE file.
 */
async function loadTaskDefinition(
  taskFilePath: string,
): Promise<{
  task: TaskDefinition;
  adapter: AdapterDefinition;
  inlineChecks: boolean;
  moduleUrl: string;
}> {
  const tempModulePath = `${taskFilePath}.${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.ts`;

  try {
    copyFileSync(taskFilePath, tempModulePath);
    const moduleUrl = pathToFileURL(tempModulePath).href;

    // Clear all registries so this import starts clean.
    resetTaskRegistry();
    resetFlowChecks();
    resetTaskTurn();
    resetTaskSteers();

    // eslint-disable-next-line react-doctor/no-dynamic-import-path -- runtime loading of user task file
    const loaded = (await import(moduleUrl)) as { default?: TaskDefinition };

    const registeredTask = getRegisteredTask();
    const task = registeredTask ?? loaded.default;
    if (!task || typeof task !== "object") {
      throw new Error(
        "No task definition found. The .eval.ts file must call task(name, { adapter, deliverables, ... }) at module top level. " +
          "If it does, the CLI and the .eval.ts may be loading different @apo-ai/sdk instances " +
          "(check for a stale packages/sdk/dist build or a version mismatch between the CLI and node_modules).",
      );
    }
    const adapter = getTaskAdapterDefinition(task);
    if (!adapter) {
      throw new Error(
        registeredTask
          ? "task() config must include an adapter"
          : "Task module must call task(name, { adapter, ... }) — the config is missing an adapter.",
      );
    }
    return {
      task,
      adapter,
      inlineChecks: registeredTask !== undefined,
      moduleUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load task definition: ${taskFilePath} (${message})`);
  } finally {
    if (existsSync(tempModulePath)) {
      unlinkSync(tempModulePath);
    }
  }
}

function validateTaskDefinition(
  task: TaskDefinition,
  taskDir: string,
): void {
  if (!task.id || typeof task.id !== "string") {
    throw new Error(`Task must have a string 'id': ${taskDir}`);
  }

  if (!task.adapter || typeof task.adapter !== "string") {
    throw new Error(`Task must have a derived string 'adapter': ${taskDir}`);
  }

  if (!Array.isArray(task.deliverables)) {
    throw new Error(`Task must have a 'deliverables' array: ${taskDir}`);
  }

  if (task.judgeTools?.mcp !== undefined) {
    if (!Array.isArray(task.judgeTools.mcp)) {
      throw new Error(`Task 'judgeTools.mcp' must be an array of MCP server configs: ${taskDir}`);
    }
    for (const server of task.judgeTools.mcp) {
      validateMcpServerConfig(server, `task 'judgeTools.mcp' (${taskDir})`);
    }
  }

  if (task.mcpServers !== undefined) {
    if (!Array.isArray(task.mcpServers)) {
      throw new Error(`Task 'mcpServers' must be an array of MCP server configs: ${taskDir}`);
    }
    for (const server of task.mcpServers) {
      validateMcpServerConfig(server, `task 'mcpServers' (${taskDir})`);
    }
  }
}

function loadFilesDirectory(taskDir: string): FileEntry[] {
  const filesDir = join(taskDir, "files");
  if (!existsSync(filesDir) || !statSync(filesDir).isDirectory()) {
    return [];
  }

  return walkDirectory(filesDir, filesDir);
}

function walkDirectory(dir: string, root: string): FileEntry[] {
  const entries: FileEntry[] = [];

  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      entries.push(...walkDirectory(fullPath, root));
    } else {
      entries.push({
        relativePath: fullPath.slice(root.length + 1),
        absolutePath: fullPath,
      });
    }
  }

  return entries;
}

function resolveChecksPath(
  task: TaskDefinition,
  taskDir: string,
): string | null {
  if (task.checks === false) {
    return null;
  }

  if (typeof task.checks === "string") {
    const customPath = resolve(taskDir, task.checks);
    if (!existsSync(customPath)) {
      throw new Error(`Custom checks file not found: ${customPath}`);
    }
    return customPath;
  }

  const conventionPath = join(taskDir, "checks.ts");
  return existsSync(conventionPath) ? conventionPath : null;
}

/** Find the first `*.eval.ts` file in a directory (the task definition). */
function findEvalFile(dir: string): string | null {
  try {
    const files = readdirSync(dir);
    const evalFile = files.find((f) => f.endsWith(".eval.ts"));
    return evalFile ? join(dir, evalFile) : null;
  } catch {
    return null;
  }
}
