"use client";

import { useMemo } from "react";

import type {
  AgentTaskRunSummary,
  AgentTaskSummary,
} from "@/lib/agent-task-api";

/**
 * Comparison model for the batch-vs-batch compare view.
 *
 * Design intent: this layer makes ZERO claims about what a difference
 * means. It aligns two batches' task runs by `task_id`, groups them by
 * folder (a folder is a "flow"), and records *whether* the two verdicts
 * differ — never *which way is worse*. Calling that a "regression" or
 * "improvement" would be an n=1 judgment we deliberately leave to the
 * human reading the row.
 */

/** One side of a comparison row: a task run, or "not run" in this batch. */
export interface ComparisonSide {
  run: AgentTaskRunSummary | null;
}

/** A task aligned across both batches. */
export interface ComparisonTask {
  taskId: string;
  /** Stable display name, falling back to the id/last path segment. */
  label: string;
  folder: string;
  left: ComparisonSide;
  right: ComparisonSide;
  /** True only when BOTH sides ran and their verdicts are not equal. A
   *  fact about two rows, not a judgment about direction. Drives the
   *  "Changes" view and the differsCount badge — never the chevron. */
  differs: boolean;
  /** True when at least one side recorded checks worth inspecting. This —
   *  not ``differs`` — drives the expand chevron: a task that failed 0/4 on
   *  both sides still has check reasoning (a judge's explanation) worth
   *  seeing, even when the two sides are identical. */
  expandable: boolean;
}

/** Aggregated check counts for one side of a comparison scope (folder or
 *  total). This is the graded signal of belief #5 — two failed tasks are not
 *  equal, so we carry Σ passed_checks / Σ total_checks alongside the binary
 *  task verdicts. Empty (zeros) when that side recorded no checks. */
export interface CheckTally {
  passed: number;
  total: number;
}

/** A flow (folder) and the tasks within it, with a count of differing tasks. */
export interface ComparisonFolder {
  folder: string;
  tasks: ComparisonTask[];
  /** Number of tasks where both sides ran and verdicts differ. A fact. */
  differsCount: number;
  /** Tasks present in only one batch (subset mismatch, belief #9). */
  onlyInOneCount: number;
  /** Σ checks across the folder's runs, per side. Graded signal. */
  leftChecks: CheckTally;
  rightChecks: CheckTally;
}

export interface ComparisonModel {
  folders: ComparisonFolder[];
  /** All aligned tasks, flat (folder.grouping applied by the caller). */
  tasks: ComparisonTask[];
  /** Total tasks that differ between the two batches. */
  totalDiffers: number;
  /** Tasks present in only one of the two batches. */
  totalOnlyInOne: number;
  /** Σ checks across every aligned task, per side. The load-bearing graded
   *  signal — distinguishes a batch that failed 1/15 from one that failed
   *  14/15, which identical task pass-rates hide. */
  leftChecks: CheckTally;
  rightChecks: CheckTally;
}

/** Verdict key used to compare two runs. Two runs "differ" iff their keys
 *  are not equal. We treat a null pass_result on a completed run as a
 *  failure state so errored runs are comparable too. */
function verdictKey(run: AgentTaskRunSummary | null): string | null {
  if (!run) return null;
  if (run.status === "running" || run.status === "pending") return run.status;
  // Terminal: distinguish pass / fail / error by status + pass_result.
  if (run.status === "error") return "error";
  return run.pass_result === true ? "passed" : "failed";
}

/** Folder label for a task path, mirroring the /tasks page convention. */
function folderOf(taskPath: string): string {
  const seg = taskPath.split("/");
  // Drop the final segment (the task itself) to get the folder.
  const folder = seg.length > 1 ? seg.slice(0, -1).join("/") : "";
  return folder || "(root)";
}

/** Human label for a task: prefer inventory display name, else last path segment. */
function taskLabel(
  taskId: string,
  taskPath: string,
  inventoryMap: Map<string, AgentTaskSummary>,
): string {
  const inv = inventoryMap.get(taskId);
  if (inv?.display_name) return inv.display_name;
  return taskPath.split("/").pop() ?? taskId;
}

/** Sum passed_checks / total_checks across a set of runs. The graded signal
 *  of belief #5: two failed task runs are not equal, and the check tallies
 *  are what carry that difference through aggregation. */
export function tallyChecks(runs: { run: AgentTaskRunSummary | null }[]): CheckTally {
  let passed = 0;
  let total = 0;
  for (const { run } of runs) {
    if (!run) continue;
    passed += run.passed_checks ?? 0;
    total += run.total_checks ?? 0;
  }
  return { passed, total };
}

/**
 * Build the comparison model from two batches' task runs plus the project's
 * task inventory (the only source of folder_path and display names).
 */
export function useComparison(
  leftRuns: AgentTaskRunSummary[],
  rightRuns: AgentTaskRunSummary[],
  inventory: AgentTaskSummary[],
): ComparisonModel {
  return useMemo(() => {
    // Inventory lookups: task_id -> folder_path (inventory) and display name.
    const inventoryMap = new Map(inventory.map((t) => [t.id, t]));

    const leftByTask = new Map(leftRuns.map((r) => [r.task_id, r]));
    const rightByTask = new Map(rightRuns.map((r) => [r.task_id, r]));

    // Union of task_ids across both batches, stable-sorted by label.
    const taskIds = Array.from(
      new Set([...leftByTask.keys(), ...rightByTask.keys()]),
    );

    const tasks: ComparisonTask[] = taskIds.map((taskId) => {
      const left = leftByTask.get(taskId) ?? null;
      const right = rightByTask.get(taskId) ?? null;
      const ref = left ?? right;
      const taskPath = ref?.task_path ?? taskId;
      const inv = inventoryMap.get(taskId);
      const folder = inv?.folder_path || folderOf(taskPath);
      const label = taskLabel(taskId, taskPath, inventoryMap);
      // differs is only true when both sides actually ran — a one-sided
      // row is a subset mismatch, not a difference in outcome. Two runs
      // "differ" when their verdict differs OR their check breakdown differs
      // (e.g. both failed, but one passed 7/8 checks and the other 2/8 —
      // that's a real difference worth expanding, not "both red, same thing").
      const bothRan = left !== null && right !== null;
      const verdictDiffers = bothRan && verdictKey(left) !== verdictKey(right);
      const checksDiffer =
        bothRan &&
        (left.passed_checks !== right.passed_checks ||
          left.failed_checks !== right.failed_checks ||
          left.total_checks !== right.total_checks);
      const differs = Boolean(verdictDiffers || checksDiffer);
      // Expandable whenever checks exist on either side — the check reasoning
      // (judge explanation, assertion detail) is worth seeing even when the
      // two sides are identical. A row with no checks on either side has
      // nothing to expand.
      const expandable =
        (left?.total_checks ?? 0) > 0 || (right?.total_checks ?? 0) > 0;
      return { taskId, label, folder, left: { run: left }, right: { run: right }, differs, expandable };
    });

    tasks.sort((a, b) => a.label.localeCompare(b.label));

    // Group by folder, preserving a stable folder order.
    const folderMap = new Map<string, ComparisonTask[]>();
    for (const t of tasks) {
      const arr = folderMap.get(t.folder) ?? [];
      arr.push(t);
      folderMap.set(t.folder, arr);
    }
    const folders: ComparisonFolder[] = Array.from(folderMap.entries())
      .map(([folder, folderTasks]) => ({
        folder,
        tasks: folderTasks,
        differsCount: folderTasks.filter((t) => t.differs).length,
        onlyInOneCount: folderTasks.filter(
          (t) => t.left.run === null || t.right.run === null,
        ).length,
        leftChecks: tallyChecks(folderTasks.map((t) => t.left)),
        rightChecks: tallyChecks(folderTasks.map((t) => t.right)),
      }))
      .sort((a, b) => a.folder.localeCompare(b.folder));

    return {
      folders,
      tasks,
      totalDiffers: tasks.filter((t) => t.differs).length,
      totalOnlyInOne: tasks.filter(
        (t) => t.left.run === null || t.right.run === null,
      ).length,
      leftChecks: tallyChecks(tasks.map((t) => t.left)),
      rightChecks: tallyChecks(tasks.map((t) => t.right)),
    };
  }, [leftRuns, rightRuns, inventory]);
}
