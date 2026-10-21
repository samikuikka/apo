/**
 * apo task publish
 *
 * Scans the local task tree, publishes bounded metadata to the Apo Task
 * Catalog, and keeps source files/repository credentials off the server.
 */

import { green, red, yellow, dim, cyan } from "../lib/format.ts";
import { parseArgs, getFlagValue, getBoolFlag } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { discoverTaskMeta } from "../lib/task-meta.ts";
import {
  blockingRemovals,
  toPublishedTask,
  type PublishTaskCatalogRequest,
  type RemovedTaskDiffEntry,
  type TaskCatalog,
} from "../lib/task-catalog.ts";
import { prepareTaskDefinition } from "../lib/task-definition.ts";
import { gitHeadSha } from "../lib/git-provenance.ts";
import { apiGet, apiPut } from "../lib/api.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const dirFlag = getFlagValue(flags, "dir");
  const taskRoot = dirFlag ?? config.taskRoot;
  const dryRun = getBoolFlag(flags, "dry-run");
  const allowEmpty = getBoolFlag(flags, "allow-empty");
  const jsonOutput = getBoolFlag(flags, "json");
  const strictRemoval = getBoolFlag(flags, "strict-removal");
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
    head_commit_sha: gitHeadSha(taskRoot) ?? undefined,
  };

  // 3. Dry run — print (and gate) without publishing anything
  if (dryRun) {
    if (jsonOutput) {
      // A gate that cannot run must not read as green: --json dry-run is a
      // pure local print by contract, so the strict gate has nothing to
      // evaluate. Refuse the combination rather than exit 0 silently.
      if (strictRemoval) {
        console.error(red("error: --strict-removal needs the catalog delta, which --dry-run --json does not fetch."));
        console.error(red("  Drop --json, or gate in CI with `apo task publish --dry-run --strict-removal`."));
        return 2;
      }
      console.log(JSON.stringify(request, null, 2));
      return 0;
    }
    console.log(cyan(`Task Catalog (dry-run, ${published.length} task${published.length === 1 ? "" : "s"}):`));
    for (const t of published) {
      console.log(`  ${t.task_id}  ${dim(`(${t.adapter_name}${t.has_checks ? ", checks" : ""})`)}`);
    }
    const delta = await computeDryRunDelta(config.backendUrl, projectId, published, config);
    if (delta === null) {
      console.log(dim(`\n  No catalog change sent. Current catalog unavailable — delta not shown.`));
      return 0;
    }
    printDelta(delta);
    console.log(dim(`\n  No catalog change sent. Remove --dry-run to publish.`));
    if (strictRemoval) {
      return gateOnRemovals(delta.removed, { dryRun: true });
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
      printPublishDiff(result);
    }
    // The publish already converged the catalog with git (it must, in CI).
    // Strict mode is the post-publish alarm: the gate that decides BEFORE
    // anything moves is `--dry-run --strict-removal`.
    if (strictRemoval && result.diff) {
      return gateOnRemovals(result.diff.removed, { dryRun: false });
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`error: ${message}`));
    return 2;
  }
}

/** The read-only catalog summary the dry-run delta needs from the server. */
interface CatalogSummary {
  id: string;
  run_stats?: { total_runs: number } | null;
}

interface DryRunDelta {
  added: string[];
  removed: RemovedTaskDiffEntry[];
}

/**
 * Diff the would-be catalog against the project's current inventory.
 * Schedule references are server-side knowledge; the dry-run delta reports
 * runs only and says so, so nobody mistakes it for the publish report.
 * Returns null when the current catalog cannot be read (offline, no
 * source) — an unavailable baseline is not a failed gate.
 */
async function computeDryRunDelta(
  backendUrl: string,
  projectId: string,
  published: Array<{ task_id: string }>,
  config: ReturnType<typeof resolveConfig>,
): Promise<DryRunDelta | null> {
  let current: unknown;
  try {
    current = await apiGet<CatalogSummary[]>(
      backendUrl,
      `/v1/projects/${encodeURIComponent(projectId)}/agent-tasks`,
      undefined,
      config,
    );
  } catch {
    return null;
  }
  // Any shape but the expected array is an unreadable baseline, not a
  // failed gate: degrade to "delta not shown" instead of throwing.
  if (!Array.isArray(current)) return null;
  const nextIds = new Set(published.map((task) => task.task_id));
  const currentIds = new Set((current as CatalogSummary[]).map((task) => task.id));
  return {
    added: [...nextIds].filter((id) => !currentIds.has(id)).sort(),
    removed: (current as CatalogSummary[])
      .filter((task) => !nextIds.has(task.id))
      .map((task) => ({
        task_id: task.id,
        display_name: task.id.split("/").pop() as string,
        run_count: task.run_stats?.total_runs ?? 0,
        schedules: [],
      }))
      .sort((a, b) => a.task_id.localeCompare(b.task_id)),
  };
}

function printDelta(delta: DryRunDelta): void {
  if (delta.removed.length === 0 && delta.added.length === 0) return;
  console.log();
  for (const entry of delta.removed) {
    console.log(red(`  would remove  ${entry.task_id}`));
    if (entry.run_count > 0) {
      console.log(yellow(`                \u26a0 ${entry.run_count} run${entry.run_count === 1 ? "" : "s"} would be archived with it`));
    }
  }
  if (delta.removed.length > 0) {
    console.log(dim(`                (schedule references are reported by the real publish)`));
  }
  for (const taskId of delta.added) {
    console.log(green(`  would add     ${taskId}`));
  }
}

/**
 * Exit 1 when a removal that costs something would happen (or happened).
 * Exit 1, not 2: the command worked, the gate said no.
 */
function gateOnRemovals(removed: RemovedTaskDiffEntry[], { dryRun }: { dryRun: boolean }): number {
  const blocking = blockingRemovals(removed);
  if (blocking.length === 0) return 0;
  console.error();
  for (const entry of blocking) {
    const costs = [
      entry.run_count > 0 ? `${entry.run_count} retained run${entry.run_count === 1 ? "" : "s"}` : null,
      entry.schedules.length > 0 ? `schedule${entry.schedules.length === 1 ? "" : "s"} ${entry.schedules.map((s) => `"${s}"`).join(", ")}` : null,
    ].filter((part) => part !== null).join(" and ");
    console.error(red(`strict-removal: ${entry.task_id} ${dryRun ? "would be removed" : "was removed"} with ${costs}`));
  }
  console.error(red(`--strict-removal gate failed. Keep the task, or acknowledge the removal by dropping the flag.`));
  return 1;
}

/**
 * Report what this publish changed — removals with their consequences
 * (retained runs, referencing schedules), additions, and probable moves.
 *
 * Warning-only by design: the catalog must converge with git either way
 * (publish runs in CI), so the report informs instead of blocking. The
 * removed tasks stay findable in the dashboard under Status → Archived.
 */
function printPublishDiff(result: TaskCatalog): void {
  const diff = result.diff;
  if (!diff) return;
  const hasContent = diff.removed.length > 0 || diff.added.length > 0 || diff.possible_renames.length > 0;
  if (!hasContent) return;

  console.log();
  for (const entry of diff.removed) {
    console.log(red(`  removed    ${entry.task_id}`));
    console.log(yellow(`             \u26a0 ${entry.run_count} run${entry.run_count === 1 ? "" : "s"} retained — findable under Status \u25b8 Archived`));
    for (const schedule of entry.schedules) {
      console.log(yellow(`             \u26a0 selected by schedule "${schedule}" — resolution will name the removal date`));
    }
  }
  for (const taskId of diff.added) {
    console.log(green(`  added      ${taskId}`));
  }
  for (const rename of diff.possible_renames) {
    const sha = rename.definition_sha256.replace(/^sha256:/, "").slice(0, 7);
    console.log(`  moved?     ${rename.from} \u2192 ${rename.to} ${dim(`(identical definition ${sha}\u2026)`)}`);
  }
}
