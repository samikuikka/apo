import { parseArgs, requirePositional, getBoolFlag } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson } from "../lib/format.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import { readLocalTaskFile } from "../lib/task-files.ts";
import type { TaskFileContentResponse } from "../lib/agent-task-types.ts";

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskId = requirePositional(positional, 0, "task-id");
  const filePath = requirePositional(positional, 1, "file-path");
  const forceLocal = getBoolFlag(flags, "local");

  let response: TaskFileContentResponse;
  let source: "backend" | "local";

  if (!forceLocal && config.projectId && await isBackendReachable(config.backendUrl)) {
    response = await apiGet<TaskFileContentResponse>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId)}/agent-tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(filePath)}`,
      undefined,
      config,
    );
    source = "backend";
  } else if (!forceLocal && await isBackendReachable(config.backendUrl)) {
    try {
      response = await apiGet<TaskFileContentResponse>(
        config.backendUrl,
        `/v1/agent-tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(filePath)}`,
        {
          task_root: config.taskRoot,
        },
        config,
      );
      source = "backend";
    } catch {
      response = readLocalTaskFile(config.taskRoot, taskId, filePath);
      source = "local";
    }
  } else {
    response = readLocalTaskFile(config.taskRoot, taskId, filePath);
    source = "local";
  }

  if (config.json) {
    console.log(formatJson({ source, ...response }));
    return 0;
  }

  console.log(dim(`# ${response.path} (${response.language}, ${response.lines} lines, ${response.size_bytes} bytes, ${source})`));
  console.log(response.content);
  return 0;
}
