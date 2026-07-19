import { parseArgs } from "../lib/args.ts";
import { apiPost } from "../lib/api.ts";
import type { ProjectTaskSource } from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, formatJson } from "../lib/format.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  if (!config.projectId) {
    console.error("Missing required flag: --project <id>");
    return 2;
  }

  const source = await apiPost<ProjectTaskSource>(
    config.backendUrl,
    `/v1/projects/${encodeURIComponent(config.projectId)}/task-source/sync`,
    {},
    config,
  );

  if (config.json) {
    console.log(formatJson(source));
    return 0;
  }

  console.log(bold(`Synced project task source: ${config.projectId}`));
  console.log(`  Status:      ${source.status}`);
  console.log(`  Commit:      ${source.last_resolved_commit_sha ?? "-"}`);
  console.log(`  Last synced: ${source.last_synced_at ?? "-"}`);
  return 0;
}
