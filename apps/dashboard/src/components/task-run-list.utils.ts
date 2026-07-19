import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
} from "lucide-react";

export type TaskRunStatus = "passed" | "failed" | "running" | "error" | "pending";

export const TASK_RUN_STATUS: Record<
  TaskRunStatus,
  { label: string; dot: string; text: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  passed: { label: "Passed", dot: "bg-success", text: "text-success", Icon: CheckCircle2 },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive", Icon: XCircle },
  running: { label: "Running", dot: "bg-foreground animate-pulse", text: "text-muted-foreground", Icon: Loader2 },
  error: { label: "Error", dot: "bg-warning", text: "text-warning", Icon: AlertTriangle },
  pending: { label: "Pending", dot: "bg-white/30", text: "text-white/50", Icon: Clock },
};

export function formatTaskRunDuration(start: string | null, end: string | null) {
  if (!start || !end) return "\u2014";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatTaskRunRelativeTime(dateStr: string | null) {
  if (!dateStr) return "\u2014";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
