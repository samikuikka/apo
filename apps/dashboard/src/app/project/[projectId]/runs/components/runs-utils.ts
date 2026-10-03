import type { ComponentType } from "react";
import { CalendarClock, GitBranch, Play, Zap } from "lucide-react";

import { type AgentTaskBatchRunSummary } from "@/lib/agent-task-api";
import { parseUTC } from "@/lib/format";

/** Task-path overlap between two batch runs, for the compare bar. */
export interface TaskOverlap {
  shared: number;
  onlyA: number;
  onlyB: number;
}

/** Column widths for the runs table. Fixed columns are px; `run` flexes. */
export const COL = {
  chevron: 28,
  run: "auto",
  source: 150,
  hosts: 160,
  execution: 180,
  tasks: 180,
  duration: 110,
  created: 150,
} as const;

export function formatDate(value: string | null): string {
  if (!value) return "\u2014";
  const d = parseUTC(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function formatRelative(value: string | null, nowMs: number | null): string {
  if (!value) return "\u2014";
  if (nowMs === null) return "\u2026";
  const date = parseUTC(value);
  const diffMs = nowMs - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatDate(value);
}

/** Elapsed time of a run. Only a `live` run without an end counts up to now. */
export function formatDuration(start: string | null, end: string | null, live: boolean): string {
  if (!start || (!end && !live)) return "\u2014";
  const startMs = parseUTC(start).getTime();
  const endMs = end ? parseUTC(end).getTime() : Date.now();
  const ms = endMs - startMs;
  if (ms < 0) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export function formatTrigger(trigger: { source: string | null; actor: string | null; schedule_name?: string | null } | null): string {
  if (!trigger) return "Manual";
  if (trigger.source === "schedule") {
    return trigger.schedule_name ? `Scheduled \u00b7 ${trigger.schedule_name}` : "Scheduled";
  }
  if (trigger.source === "manual") return "Manual";
  if (trigger.source === "ci") return "CI / Pipeline";
  if (trigger.actor) return trigger.actor;
  return trigger.source ?? "Manual";
}

export function getTaskPaths(batch: AgentTaskBatchRunSummary): string[] {
  const q = batch.selection_query;
  if (q && typeof q === "object" && "task_paths" in q) {
    const paths = q.task_paths;
    if (Array.isArray(paths)) return paths.map((p: string) => p.split("/").pop() ?? p);
  }
  return [];
}

export function getFullTaskPaths(batch: AgentTaskBatchRunSummary): string[] {
  const q = batch.selection_query;
  if (q && typeof q === "object" && "task_paths" in q) {
    const paths = q.task_paths;
    if (Array.isArray(paths) && paths.length > 0) return paths as string[];
  }
  return [];
}

export function computeOverlap(
  a: AgentTaskBatchRunSummary,
  b: AgentTaskBatchRunSummary,
): TaskOverlap | null {
  const aPaths = new Set(getFullTaskPaths(a));
  const bPaths = new Set(getFullTaskPaths(b));
  if (aPaths.size === 0 || bPaths.size === 0) return null;
  let shared = 0;
  for (const p of aPaths) if (bPaths.has(p)) shared++;
  return { shared, onlyA: aPaths.size - shared, onlyB: bPaths.size - shared };
}

export function getBatchName(batch: AgentTaskBatchRunSummary): string {
  const paths = getTaskPaths(batch);
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) return `${paths.length} tasks`;
  if (batch.selection_type === "all") return "All discovered tasks";
  return batch.selection_type;
}

export function getSourceIcon(source: string | null): ComponentType<{ className?: string }> {
  if (source === "schedule") return CalendarClock;
  if (source === "ci") return GitBranch;
  if (source === "dashboard") return Play;
  return Zap;
}
