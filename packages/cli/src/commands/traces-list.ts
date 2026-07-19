import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson, formatTable, formatTime } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { highlightIds } from "../lib/prefix.ts";

type TraceSummary = {
  id: string;
  task_id: string | null;
  flow_name: string | null;
  status: string;
  call_count: number;
  duration_ms: number | null;
  primary_model: string | null;
  error_count: number;
  warning_count: number;
  created_at: string;
};

type TraceListResponse = {
  data: TraceSummary[];
  total_count: number;
  page: number;
  page_size: number;
};

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const params: Record<string, string> = {};
  if (config.projectId) params.project = config.projectId;
  const taskId = getFlagValue(flags, "task");
  if (taskId) params.task_id = taskId;
  const limit = getFlagValue(flags, "limit") ?? "20";
  params.limit = limit;

  let response: TraceListResponse;
  try {
    response = await apiGet<TraceListResponse>(
      config.backendUrl,
      "/v1/runs",
      params,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Backend error") || message.includes("timed out") || message.includes("Cannot connect")) {
      console.error(message);
    } else {
      console.error(`Cannot connect to backend at ${config.backendUrl}`);
      console.error(dim(message));
    }
    return 2;
  }

  const traces = response.data ?? [];

  if (config.json) {
    console.log(formatJson(traces));
    return 0;
  }

  if (traces.length === 0) {
    console.log(dim("No traces found"));
    return 0;
  }

  const idLabels = highlightIds(traces.map((t) => t.id));
  const rows = traces.map((t, i) => [
    idLabels[i],
    (t.task_id ?? t.flow_name ?? "-").slice(0, 20),
    t.status,
    String(t.call_count),
    t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)}s` : "-",
    (t.primary_model ?? "-").slice(0, 20),
    formatTime(t.created_at),
  ]);
  console.log(
    formatTable(["Trace ID", "Task", "Status", "Calls", "Duration", "Model", "Created"], rows),
  );
  console.log("");
  console.log(dim(`${response.total_count} traces total`));

  return 0;
}
