/**
 * Trace column metadata shared by the column factory and the table panels.
 *
 * Lives in a `.ts` module (not `columns.tsx`) so the component file can export
 * only React components — keeping Fast Refresh able to preserve state.
 */

/** Display label per trace column id. Empty string means no header text. */
export const COLUMN_LABELS: Record<string, string> = {
  bookmark: "",
  status: "Status",
  id: "ID",
  name: "Name",
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
