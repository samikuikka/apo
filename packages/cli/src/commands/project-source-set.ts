import { getFlagValue, parseArgs } from "../lib/args.ts";
import { apiPatch } from "../lib/api.ts";
import type {
  ProjectTaskSource,
  UpdateProjectTaskSourceRequest,
} from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, formatJson } from "../lib/format.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  if (!config.projectId) {
    console.error("Missing required flag: --project <id>");
    return 2;
  }

  const sourceType = getRequiredFlag(flags, "type");
  if (!sourceType) {
    return 2;
  }

  const body = buildRequest(flags, sourceType);
  if (!body) {
    return 2;
  }

  const source = await apiPatch<ProjectTaskSource>(
    config.backendUrl,
    `/v1/projects/${encodeURIComponent(config.projectId)}/task-source`,
    body,
    config,
  );

  if (config.json) {
    console.log(formatJson(source));
    return 0;
  }

  console.log(bold(`Updated project task source: ${config.projectId}`));
  console.log(`  Type:    ${source.source_type}`);
  console.log(`  Name:    ${source.display_name}`);
  console.log(`  Status:  ${source.status}`);
  return 0;
}

function buildRequest(
  flags: Record<string, string | boolean>,
  sourceType: string,
): UpdateProjectTaskSourceRequest | null {
  if (sourceType === "git") {
    const repositoryUrl = getRequiredFlag(flags, "repo");
    if (!repositoryUrl) {
      return null;
    }
    return {
      source_type: "git",
      display_name: getFlagValue(flags, "name") ?? null,
      repository_url: repositoryUrl,
      git_ref: getFlagValue(flags, "ref") ?? "main",
      subpath: getFlagValue(flags, "subpath") ?? null,
    };
  }

  if (sourceType === "filesystem") {
    const filesystemPath = getRequiredFlag(flags, "path");
    if (!filesystemPath) {
      return null;
    }
    return {
      source_type: "filesystem",
      display_name: getFlagValue(flags, "name") ?? null,
      filesystem_path: filesystemPath,
      subpath: getFlagValue(flags, "subpath") ?? null,
    };
  }

  if (sourceType === "demo") {
    return {
      source_type: "demo",
      display_name: getFlagValue(flags, "name") ?? null,
      demo_seed_id: getFlagValue(flags, "seed") ?? "default",
      subpath: getFlagValue(flags, "subpath") ?? null,
    };
  }

  console.error(`Unsupported source type: ${sourceType}`);
  console.error("Use one of: git, filesystem, demo");
  return null;
}

function getRequiredFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string | null {
  const value = getFlagValue(flags, name);
  if (value) {
    return value;
  }
  console.error(`Missing required flag: --${name} <value>`);
  return null;
}
