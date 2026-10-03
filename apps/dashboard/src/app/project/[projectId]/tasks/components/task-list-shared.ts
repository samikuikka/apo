import type { AgentTaskSummary } from "@/lib/agent-task-api";
import { TASK_STATUS_FILTERS } from "@/lib/filter-status";

export type FolderNode = {
  id: string;
  tasks: AgentTaskSummary[];
};

// Evidence views: a tab is a model/effort filter. The Main tab
// (model=null) is permanent and shows all-history; every other tab is a
// closable copy narrowed by model (+ model-aware effort).
export const MAIN_VIEW_ID = "main";

export interface ViewTab {
  id: string;
  label: string;
  model: string | null;  // null = All models (Main)
  effort: string | null; // null = any effort
  since: string | null;  // "7d" | "30d" | "90d" | null (all time)
  provider: string | null; // observed serving host; null = any host (issue #307)
}

// The task status vocabulary lives in lib/filter-status alongside the other
// entities' vocabularies; the filter bar consumes it from there directly.
export const STATUS_FILTER_KEYS = TASK_STATUS_FILTERS.map((s) => s.value);

export function taskFilterStatus(task: AgentTaskSummary): TaskStatus {
  const stats = task.run_stats;
  if (!stats || !stats.last_run_status) return "idle";
  if (stats.last_run_status === "error") return stats.last_run_no_verdict ? "no_verdict" : "errored";
  if (stats.last_run_status === "running" || stats.last_run_status === "pending") return "running";
  if (stats.last_run_passed === true) return "passed";
  return "failed";
}

export function groupByFolder(tasks: AgentTaskSummary[]): FolderNode[] {
  const groups: Record<string, AgentTaskSummary[]> = {};
  for (const task of tasks) {
    const folder = task.folder_path || "(root)";
    if (!groups[folder]) groups[folder] = [];
    groups[folder].push(task);
  }
  return Object.entries(groups).map(([name, tasks]) => ({ id: name, tasks }));
}

export type TaskStatus = "passed" | "failed" | "errored" | "no_verdict" | "running" | "idle";

/** The latest run's verdict; agrees with {@link taskFilterStatus}. An `error`
 * run is never FAILED: a judge that gave no verdict (issue #323) reads "No
 * verdict", an execution error "Errored". */
export function getTaskStatus(task: AgentTaskSummary): TaskStatus {
  // One mapping for the card and the filter, so they can't disagree.
  return taskFilterStatus(task);
}

export const STATUS_CONFIG: Record<Exclude<TaskStatus, "idle">, { label: string; dot: string; text: string }> = {
  passed:     { label: "Passed",     dot: "bg-success",              text: "text-success" },
  failed:     { label: "Failed",     dot: "bg-destructive",          text: "text-destructive" },
  errored:    { label: "Errored",    dot: "bg-warning",              text: "text-warning" },
  no_verdict: { label: "No verdict", dot: "bg-warning",              text: "text-warning" },
  running:    { label: "Running",    dot: "bg-foreground animate-pulse", text: "text-muted-foreground" },
};
