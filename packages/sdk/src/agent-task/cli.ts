import { relative, resolve } from "path";
import { discoverAgentTaskDirs } from "./discovery.ts";
import { runTaskDir, type AgentTaskRunSummary } from "./task-runtime.ts";

export type AgentTaskCliOptions = {
  task?: string;
  dir?: string;
  grep?: string;
  help?: boolean;
};

export function parseAgentTaskCliArgs(argv: string[]): AgentTaskCliOptions {
  const options: AgentTaskCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--task") {
      options.task = requireNextValue(argv, index, "--task");
      index += 1;
      continue;
    }

    if (arg === "--dir") {
      options.dir = requireNextValue(argv, index, "--dir");
      index += 1;
      continue;
    }

    if (arg === "--grep") {
      options.grep = requireNextValue(argv, index, "--grep");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.task && options.dir) {
    throw new Error("Use either --task or --dir, not both");
  }

  return options;
}

export async function runAgentTaskCli(
  argv: string[],
  cwd = process.cwd(),
): Promise<number> {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = parseAgentTaskCliArgs(normalizedArgv);

  if (options.help) {
    printHelp();
    return 0;
  }

  const selectedTaskDirs = resolveSelectedTaskDirs(options, cwd);
  if (selectedTaskDirs.length === 0) {
    throw new Error("No task folders found for the selected input");
  }

  let hasFailures = false;
  let hasErrors = false;

  const results = await Promise.allSettled(
    selectedTaskDirs.map((taskDir) => runTaskDir(taskDir))
  );

  const summaries: AgentTaskRunSummary[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const taskDir = selectedTaskDirs[i];
    if (result.status === "fulfilled") {
      summaries.push(result.value);
      printTaskSummary(result.value, cwd);
      hasFailures ||= !result.value.pass;
    } else {
      hasErrors = true;
      printTaskError(taskDir, cwd, result.reason);
    }
  }

  printOverallSummary(summaries, hasErrors);

  if (hasErrors) {
    return 2;
  }

  return hasFailures ? 1 : 0;
}

function resolveSelectedTaskDirs(
  options: AgentTaskCliOptions,
  cwd: string,
): string[] {
  if (options.task) {
    return [resolve(cwd, options.task)];
  }

  const rootDir = resolve(cwd, options.dir ?? "e2e");
  const discovered = discoverAgentTaskDirs(rootDir);

  if (!options.grep) {
    return discovered;
  }

  return discovered.filter((taskDir) =>
    // String.prototype.includes (not Array.includes) — false positive
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    relative(cwd, taskDir).includes(options.grep as string),
  );
}

function requireNextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp(): void {
  console.log("Usage: agent-task-e2e [--task <task-folder> | --dir <tasks-root>] [--grep <substring>]");
  console.log("");
  console.log("Options");
  console.log("- --task <path>  Run one task folder");
  console.log("- --dir <path>   Run all task folders under a root directory");
  console.log("- --grep <text>  Filter discovered task paths by substring");
  console.log("- --help         Show this help");
}

function printTaskSummary(summary: AgentTaskRunSummary, cwd: string): void {
  const relativeTaskDir = relative(cwd, summary.taskDir);
  console.log("");
  console.log(`${summary.pass ? "PASS" : "FAIL"} ${summary.taskId}`);
  console.log(`Path: ${relativeTaskDir}`);

  printResultGroup("Checks", summary.checks);
}

function printResultGroup(
  label: string,
  results: AgentTaskRunSummary["checks"],
): void {
  if (results.length === 0) {
    return;
  }

  console.log(label);
  for (const result of results) {
    console.log(`- ${result.id}: ${result.pass ? "PASS" : "FAIL"}`);
    if (result.reasoning) {
      console.log(`  ${result.reasoning}`);
    }
  }
}

function printTaskError(taskDir: string, cwd: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log("");
  console.log(`ERROR ${relative(cwd, taskDir)}`);
  console.log(message);
}

function printOverallSummary(
  summaries: AgentTaskRunSummary[],
  hasErrors: boolean,
): void {
  const passed = summaries.filter((summary) => summary.pass).length;
  const failed = summaries.length - passed;

  console.log("");
  console.log("Summary");
  console.log(`- total: ${summaries.length}`);
  console.log(`- passed: ${passed}`);
  console.log(`- failed: ${failed}`);
  console.log(`- errors: ${hasErrors ? "yes" : "no"}`);
}
