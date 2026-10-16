/**
 * apo task publish
 *
 * Scans the local task tree, publishes bounded metadata to the Apo Task
 * Catalog, and keeps source files/repository credentials off the server.
 */

import { join } from "node:path";
import { green, red, dim, cyan } from "../lib/format.ts";
import { parseArgs, getFlagValue, getBoolFlag } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { discoverTaskMeta } from "../lib/task-meta.ts";
import { toPublishedTask, type PublishTaskCatalogRequest, type TaskCatalog } from "../lib/task-catalog.ts";
import { prepareTaskDefinition } from "../lib/task-definition.ts";
import { firstCommitForFile } from "../lib/git-provenance.ts";
import { apiPut } from "../lib/api.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const dirFlag = getFlagValue(flags, "dir");
  const taskRoot = dirFlag ?? config.taskRoot;
  const dryRun = getBoolFlag(flags, "dry-run");
  const allowEmpty = getBoolFlag(flags, "allow-empty");
  const jsonOutput = getBoolFlag(flags, "json");
  const projectFlag = getFlagValue(flags, "project");
  const projectId = projectFlag ?? config.projectId;

  if (!projectId) {
    console.error(red("error: no project configured. Run `apo project use` first."));
    return 2;
  }

  // 1. Discover tasks locally
  const tasks = discoverTaskMeta(taskRoot);

  if (tasks.length === 0 && !allowEmpty) {
    console.error(red("error: no tasks discovered. Use --allow-empty to publish an empty catalog."));
    console.error(dim(`  scanned: ${taskRoot}`));
    return 2;
  }

  // 2. Map to publication allowlist + prepare Task Definition source
  const published = tasks
    .map((meta) => {
      const task = toPublishedTask(meta);
      const prepared = prepareTaskDefinition(meta);
      task.definition = prepared.document;
      if (meta.description) task.description = meta.description;
      // Who added this task, best-effort: absent without git history, and
      // the server falls back to first-published (issue #444).
      const provenance = firstCommitForFile(join(meta.path, meta.evalFileName));
      if (provenance) {
        task.git_author_name = provenance.authorName;
        task.git_author_email = provenance.authorEmail;
        task.git_first_commit_at = provenance.authorDate;
        task.git_first_commit_sha = provenance.sha;
      }
      return task;
    })
    .sort((a, b) => a.task_id.localeCompare(b.task_id));

  // Sort tags within each task
  for (const t of published) {
    t.tags.sort();
  }

  const request: PublishTaskCatalogRequest = {
    schema_version: 2 as const,
    tasks: published,
  };

  // 3. Dry run — print and exit
  if (dryRun) {
    if (jsonOutput) {
      console.log(JSON.stringify(request, null, 2));
    } else {
      console.log(cyan(`Task Catalog (dry-run, ${published.length} task${published.length === 1 ? "" : "s"}):`));
      for (const t of published) {
        console.log(`  ${t.task_id}  ${dim(`(${t.adapter_name}${t.has_checks ? ", checks" : ""})`)}`);
      }
      console.log(dim(`\n  No HTTP request sent. Remove --dry-run to publish.`));
    }
    return 0;
  }

  // 4. Publish
  try {
    const result = await apiPut<TaskCatalog>(config.backendUrl, `/v1/projects/${projectId}/task-catalog`, request, config);
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(green(`\u2713 Published ${result.task_count} task${result.task_count === 1 ? "" : "s"} to ${projectId}`));
      console.log(dim(`  digest: ${result.catalog_digest?.slice(0, 20) ?? "?"}...`));
      console.log(dim(`  published_at: ${result.published_at ?? "?"}`));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`error: ${message}`));
    return 2;
  }
}
