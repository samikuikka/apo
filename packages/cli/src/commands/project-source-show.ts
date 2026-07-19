import { parseArgs } from "../lib/args.ts";
import { apiGet } from "../lib/api.ts";
import type { ProjectTaskSource } from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  if (!config.projectId) {
    console.error("Missing required flag: --project <id>");
    return 2;
  }

  const source = await apiGet<ProjectTaskSource | null>(
    config.backendUrl,
    `/v1/projects/${encodeURIComponent(config.projectId)}/task-source`,
    undefined,
    config,
  );

  if (config.json) {
    console.log(formatJson(source));
    return 0;
  }

  if (!source) {
    console.log(dim(`Project ${config.projectId} has no task source configured`));
    return 0;
  }

  console.log(bold(`Project task source: ${config.projectId}`));
  console.log(`  Type:          ${source.source_type}`);
  console.log(`  Name:          ${source.display_name}`);
  console.log(`  Status:        ${source.status}`);
  console.log(`  Repository:    ${source.repository_url ?? "-"}`);
  console.log(`  Ref:           ${source.git_ref ?? "-"}`);
  console.log(`  Subpath:       ${source.subpath ?? "-"}`);
  console.log(`  Filesystem:    ${source.filesystem_path ?? "-"}`);
  console.log(`  Demo seed:     ${source.demo_seed_id ?? "-"}`);
  console.log(`  Last synced:   ${source.last_synced_at ?? "-"}`);
  console.log(`  Commit:        ${source.last_resolved_commit_sha ?? "-"}`);
  if (source.last_error) {
    console.log(`  Last error:    ${source.last_error}`);
  }

  return 0;
}
