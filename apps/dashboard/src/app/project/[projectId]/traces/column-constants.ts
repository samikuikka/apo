/**
 * Trace column metadata and metric lookup shared by the column factory and
 * the table panels.
 *
 * Lives in a `.ts` module (not `columns.tsx`) so the component file can export
 * only React components — keeping Fast Refresh able to preserve state.
 */

import type { TraceMetric } from "@/lib/traces-api";

/** Display label per trace column id. Empty string means no header text. */
export const COLUMN_LABELS: Record<string, string> = {
  bookmark: "",
  status: "Status",
  id: "ID",
  name: "Name",
  service: "Service",
  task: "Task",
  environment: "Env",
  primary_model: "Model",
  tags: "Tags",
  call_count: "Calls",
  latency: "Latency",
  usage: "Usage",
  created_at: "Created",
};

/** Maps a trace column id to the backend sort field it corresponds to. */
export const COLUMN_SORT_MAP: Record<string, string> = {
  created_at: "created_at",
  latency: "duration_ms",
  call_count: "call_count",
};

/** Look one metric up on a trace's metric list; null when absent. */
export function getMetric(metrics: TraceMetric[], name: string): number | null {
  const m = metrics.find((m) => m.metric_name === name);
  return m ? m.score : null;
}
