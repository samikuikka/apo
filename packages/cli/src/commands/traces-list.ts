import { getFlagValues, parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson, formatTable, formatTime } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { highlightIds } from "../lib/prefix.ts";
import { reportCommandError } from "../lib/command-error.ts";

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
  const { flags, multiFlags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const params: Record<string, string> = {};
  if (config.projectId) params.project = config.projectId;
  const taskId = getFlagValue(flags, "task");
  if (taskId) params.task_id = taskId;

  // Span-derived search. --attr compiles into a span_filter JSON
  // array; supported forms: key=value, key!=value, key>v, key>=v, key<v,
  // key<=v, key~=v (contains), key?=v (exists takes no value), and
  // key in v1,v2.
  const service = getFlagValue(flags, "service");
  if (service) params.service = service;
  const operation = getFlagValue(flags, "operation");
  if (operation) params.operation = operation;
  const spanText = getFlagValue(flags, "span-text");
  if (spanText) params.span_text = spanText;
  const attrs = getFlagValues(multiFlags, "attr");
  const predicates = attrs.map(parseAttrFlag).filter((p) => p !== null);
  if (predicates.length > 0) params.span_filter = JSON.stringify(predicates);
  // /v1/runs paginates with page_size (max 100) — there is no `limit` param,
  // so an unmapped flag would silently fetch the 40-row default page.
  const limit = getFlagValue(flags, "limit") ?? "20";
  params.page_size = limit;

  let response: TraceListResponse;
  try {
    response = await apiGet<TraceListResponse>(
      config.backendUrl,
      "/v1/runs",
      params,
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
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


type SpanPredicate = {
  field: string;
  op: string;
  value?: string | number | string[];
};

const NUMERIC_OPS = new Set(["gt", "gte", "lt", "lte"]);

function parseAttrFlag(raw: string): SpanPredicate | null {
  const inMatch = raw.match(/^([\w./:-]+)\s+in\s+(.+)$/);
  if (inMatch) {
    return {
      field: `attribute:${inMatch[1]}`,
      op: "in",
      value: inMatch[2].split(",").map((v) => v.trim()).filter(Boolean),
    };
  }
  if (raw.endsWith("?")) {
    return { field: `attribute:${raw.slice(0, -1)}`, op: "exists" };
  }
  const m = raw.match(/^([\w./:-]+)(!=|>=|<=|=|>|<|~=)(.+)$/);
  if (!m) {
    console.error(`invalid --attr ${raw} (expected key=value, key!=v, key>v, key~=v, key in a,b, or key?)`);
    return null;
  }
  const [, key, symbol, rawValue] = m;
  const opBySymbol: Record<string, string> = {
    "=": "eq",
    "!=": "neq",
    ">": "gt",
    ">=": "gte",
    "<": "lt",
    "<=": "lte",
    "~=": "contains",
  };
  const op = opBySymbol[symbol] ?? "eq";
  const numeric = NUMERIC_OPS.has(op);
  return {
    field: `attribute:${key}`,
    op,
    value: numeric ? Number(rawValue) : rawValue,
  };
}
