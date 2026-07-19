import { parseArgs } from "../lib/args.ts";
import { apiGet, apiPost } from "../lib/api.ts";
import type { AgentTaskSummary, ProjectTaskSource } from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, formatJson } from "../lib/format.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  if (!config.projectId) {
    console.error("Missing project. Pass --project <id> or set APO_PROJECT_ID / use apo login.");
    return 2;
  }

  const source = await apiPost<ProjectTaskSource>(
    config.backendUrl,
    `/v1/projects/${encodeURIComponent(config.projectId)}/task-source/sync`,
    {},
    config,
  );
  const tasks = await apiGet<AgentTaskSummary[]>(
    config.backendUrl,
    `/v1/projects/${encodeURIComponent(config.projectId)}/agent-tasks`,
    undefined,
    config,
  );

  if (config.json) {
    console.log(formatJson({
      project: config.projectId,
      source,
      task_count: tasks.length,
    }));
    return 0;
  }

  console.log(bold(`Synced project tasks: ${config.projectId}`));
  console.log(`  Status:  ${source.status}`);
  console.log(`  Commit:  ${source.last_resolved_commit_sha ?? "-"}`);
  console.log(`  Tasks:   ${tasks.length}`);
  return 0;
}
