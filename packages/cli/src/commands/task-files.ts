import { parseArgs, requirePositional, getBoolFlag } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson, formatTable } from "../lib/format.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import { listLocalTaskFiles } from "../lib/task-files.ts";
import type { TaskFileListResponse } from "../lib/agent-task-types.ts";

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskId = requirePositional(positional, 0, "task-id");
  const forceLocal = getBoolFlag(flags, "local");

  let response: TaskFileListResponse;
  let source: "backend" | "local";

  if (!forceLocal && config.projectId && await isBackendReachable(config.backendUrl)) {
    response = await apiGet<TaskFileListResponse>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId)}/agent-tasks/${encodeURIComponent(taskId)}/files`,
      undefined,
      config,
    );
    source = "backend";
  } else if (!forceLocal && await isBackendReachable(config.backendUrl)) {
    try {
      response = await apiGet<TaskFileListResponse>(
        config.backendUrl,
        `/v1/agent-tasks/${encodeURIComponent(taskId)}/files`,
        {
          task_root: config.taskRoot,
        },
        config,
      );
      source = "backend";
    } catch {
      response = listLocalTaskFiles(config.taskRoot, taskId);
      source = "local";
    }
  } else {
    response = listLocalTaskFiles(config.taskRoot, taskId);
    source = "local";
  }

  if (config.json) {
    console.log(formatJson({ source, ...response }));
    return 0;
  }

  if (response.files.length === 0) {
    console.log(dim("No task files found"));
    return 0;
  }

  const rows = response.files.map((file) => [
    file.path,
    file.type,
    file.extension ?? "—",
    file.size_bytes === null ? "—" : String(file.size_bytes),
  ]);
  console.log(formatTable(["Path", "Type", "Ext", "Bytes"], rows));
  console.log("");
  console.log(dim(`${response.files.length} entries via ${source}`));
  return 0;
}
