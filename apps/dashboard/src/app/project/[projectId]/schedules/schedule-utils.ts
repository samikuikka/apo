import {
  type AgentTaskScheduleSummary,
  type ScheduleLastBatchSummary,
  type FailureBreakdownItem,
} from "@/lib/agent-task-api";
import { describeSchedule } from "@/components/schedule/compute-upcoming";
import { parseUTC } from "@/lib/format";

export function formatDate(value: string | null): string {
  if (!value) return "\u2014";
  const d = parseUTC(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatRelativePast(value: string | null, nowMs: number | null): string {
  if (!value) return "\u2014";
  if (nowMs === null) return "\u2026";
  const date = parseUTC(value);
  const diffMs = Math.max(0, nowMs - date.getTime());
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatDate(value);
}

export function formatRelativeFuture(value: string | null, nowMs: number | null): string {
  if (!value) return "\u2014";
  if (nowMs === null) return "\u2026";
  const date = parseUTC(value);
  const diffMs = Math.max(0, date.getTime() - nowMs);
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "in <1m";
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `in ${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `in ${diffDay}d`;
  return formatDate(value);
}

export function formatCadence(schedule: AgentTaskScheduleSummary): string {
  return describeSchedule({
    cadence_type: schedule.cadence_type as "daily" | "weekly" | "monthly" | "adaptive",
    timezone: schedule.timezone,
    hour: schedule.hour,
    minute: schedule.minute,
    day_of_week: schedule.day_of_week,
    day_of_month: schedule.day_of_month,
    min_interval_days: schedule.min_interval_days,
    max_interval_days: schedule.max_interval_days,
  });
}

export function summarizeTasks(schedule: AgentTaskScheduleSummary): string {
  const paths = schedule.selection_query?.task_paths;
  if (Array.isArray(paths) && paths.length > 0) {
    if (paths.length === 1 && typeof paths[0] === "string") {
      const name = paths[0].split("/").pop();
      return name || paths[0];
    }
    return `${paths.length} selected tasks`;
  }
  if (schedule.selection_type === "all") return "All discovered tasks";
  if (schedule.grep) return `Tasks matching "${schedule.grep}"`;
  return "All discovered tasks";
}

export type ScheduleOutcome =
  | "healthy"
  | "degraded"
  | "failing"
  | "running"
  | "not_established"
  | "paused";

export function getScheduleOutcome(
  schedule: AgentTaskScheduleSummary,
): ScheduleOutcome {
  if (!schedule.enabled) return "paused";
  const batch = schedule.last_batch;
  if (!batch) return "not_established";
  if (batch.status === "running" || batch.status === "queued") return "running";
  if (batch.total_tasks === 0) return "healthy";
  const rate = (batch.passed_tasks / batch.total_tasks) * 100;
  if (rate < 80) return "failing";
  if (rate < 95) return "degraded";
  return "healthy";
}

export function computePassRate(batch: ScheduleLastBatchSummary): number {
  if (batch.total_tasks === 0) return 0;
  return Math.round((batch.passed_tasks / batch.total_tasks) * 100);
}

export function outcomeLabel(outcome: ScheduleOutcome): string {
  switch (outcome) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "failing":
      return "Failing";
    case "running":
      return "Running";
    case "not_established":
      return "Never run";
    case "paused":
      return "Paused";
  }
}

export function outcomeColor(outcome: ScheduleOutcome): string {
  switch (outcome) {
    case "healthy":
      return "text-success";
    case "degraded":
      return "text-warning";
    case "failing":
      return "text-destructive";
    case "running":
      return "text-muted-foreground";
    case "not_established":
      return "text-muted-foreground";
    case "paused":
      return "text-muted-foreground";
  }
}

export function outcomeDot(outcome: ScheduleOutcome): string {
  switch (outcome) {
    case "healthy":
      return "bg-success";
    case "degraded":
      return "bg-warning";
    case "failing":
      return "bg-destructive";
    case "running":
      return "bg-foreground animate-pulse";
    case "not_established":
      return "bg-muted-foreground/30";
    case "paused":
      return "bg-muted-foreground/30";
  }
}

export function formatBatchCounts(batch: ScheduleLastBatchSummary): string {
  if (batch.total_tasks === 0) return "0 tasks";
  const rate = computePassRate(batch);
  return `${batch.passed_tasks}/${batch.total_tasks} · ${rate}%`;
}

export function formatFailureSummary(
  breakdown: FailureBreakdownItem[],
): string {
  if (breakdown.length === 0) return "";
  return breakdown
    .map((item) => `${item.count} ${item.label.toLowerCase()}`)
    .join(" · ");
}

export function formatConsecutiveFailures(count: number): string | null {
  if (count <= 1) return null;
  return `Failed ${count} in a row`;
}
