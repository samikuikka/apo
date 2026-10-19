/**
 * Client-published Task Catalog types.
 *
 * The CLI scans Tasks locally and publishes only bounded dashboard metadata.
 * Source files, prompts, fixtures, repository credentials, and absolute
 * paths never cross the publication boundary — except the canonical
 * ``*.eval.ts`` definition itself, which is private Project data
 * like traces and Deliverables.
 */

import type { TaskDefinitionDocument } from "./task-definition.ts";

export type PublishedTask = {
  task_id: string;
  display_name: string;
  task_path: string;
  folder_path: string;
  adapter_name: string;
  has_checks: boolean;
  tags: string[];
  /** The canonical eval source. */
  definition?: TaskDefinitionDocument;
  /**
   * Best-effort authorship (issue #444): the commit that added the eval
   * file. Absent on shallow clones and non-git task roots — the server
   * falls back to first-published. Excluded from the catalog digest on
   * both sides, so provenance availability can never move the digest
   * `apo connect` claims gate on.
   */
  git_author_name?: string;
  git_author_email?: string;
  /** ISO-8601 author date of the adding commit. */
  git_first_commit_at?: string;
  git_first_commit_sha?: string;
  /** The eval's declared description, read statically by the scanner. */
  description?: string;
};

export type PublishTaskCatalogRequest = {
  schema_version: 1 | 2;
  tasks: PublishedTask[];
};

/** One task that left the catalog in this publish, with consequences. */
export type RemovedTaskDiffEntry = {
  task_id: string;
  display_name: string;
  run_count: number;
  schedules: string[];
};

/** Removed + added ids pinning identical definition content — a probable move. */
export type PossibleRename = {
  from: string;
  to: string;
  definition_sha256: string;
};

export type PublishDiff = {
  added: string[];
  removed: RemovedTaskDiffEntry[];
  possible_renames: PossibleRename[];
};

export type TaskCatalog = {
  project: string;
  schema_version: 1 | 2;
  task_count: number;
  catalog_digest: string;
  published_at: string;
  execution_mode: "caller" | "bundled_demo";
  diff?: PublishDiff;
  /** Legacy pre-diff keys, kept so old servers still print. */
  removed_tasks?: string[];
  affected_schedules?: Array<{
    id: string;
    name: string;
    pruned_states: number;
    selection_references: string[];
  }>;
};

/**
 * Map discovered TaskMeta to the publication allowlist.
 * Strips all source-derived data (absolute paths, files, deliverables, etc.).
 */
export function toPublishedTask(meta: {
  id: string;
  folderPath: string;
  adapter: string;
  hasChecks: boolean;
}): PublishedTask {
  const segments = meta.id.split("/");
  const displayName = segments[segments.length - 1];
  return {
    task_id: meta.id,
    display_name: displayName,
    task_path: meta.id,
    folder_path: meta.folderPath,
    adapter_name: meta.adapter,
    has_checks: meta.hasChecks,
    tags: [],
  };
}
