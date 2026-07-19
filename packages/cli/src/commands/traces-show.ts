import { parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatCost, formatJson, formatTime, red } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { findByPrefix } from "../lib/prefix.ts";

type TraceCall = {
  id: string;
  model: string | null;
  observation_type: string;
  step_name: string | null;
  level: string;
  latency_ms: number | null;
  cost: number | null;
  total_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  time_to_first_token_ms: number | null;
  parent_call_id: string | null;
  status_message: string | null;
  created_at: string;
  input: unknown;
  output: unknown;
  messages: unknown[] | null;
  tool_name: string | null;
  tool_parameters: Record<string, unknown> | null;
  tool_result: unknown;
  metadata: Record<string, unknown> | null;
};

type TraceRun = {
  id: string;
  task_id: string | null;
  flow_name: string | null;
  status: string;
  duration_ms: number | null;
  environment: string;
  tags: string[];
  created_at: string;
  completed_at: string | null;
};

type TraceDetail = {
  run: TraceRun;
  calls: TraceCall[];
  metrics: unknown[];
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const traceId = requirePositional(positional, 0, "trace-id");
  const verbose = flags.verbose === true || flags.v === true;
  const errorsOnly = flags["errors-only"] === true;

  let resolvedTraceId = traceId;
  if (traceId.length < 20) {
    try {
      resolvedTraceId = await resolveTraceIdByPrefix(config.backendUrl, traceId, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404")) {
        console.error(`Trace not found: ${traceId}`);
      } else if (message.startsWith("Backend error") || message.includes("matches multiple")) {
        console.error(message);
      } else {
        console.error(`Cannot connect to backend at ${config.backendUrl}`);
      }
      return 2;
    }
  }

  let trace: TraceDetail;
  try {
    const params: Record<string, string> = {};
    if (config.projectId) params.project = config.projectId;
    trace = await apiGet<TraceDetail>(
      config.backendUrl,
      `/v1/runs/${resolvedTraceId}`,
      Object.keys(params).length > 0 ? params : undefined,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      console.error(`Trace not found: ${traceId}`);
    } else if (message.startsWith("Backend error") || message.includes("timed out") || message.includes("Cannot connect")) {
      console.error(message);
    } else {
      console.error(`Cannot connect to backend at ${config.backendUrl}`);
      console.error(dim(message));
    }
    return 2;
  }

  if (config.json) {
    console.log(formatJson(trace));
    return 0;
  }

  const calls = errorsOnly
    ? trace.calls.filter((c) => c.level === "ERROR" || c.level === "WARNING")
    : trace.calls;

  printTraceDetail(trace, calls, verbose);
  return 0;
}

type TraceListResponse = {
  data: Array<{ id: string }>;
  total_count: number;
};

async function resolveTraceIdByPrefix(
  backendUrl: string,
  prefix: string,
  config: ReturnType<typeof resolveConfig>,
): Promise<string> {
  const params: Record<string, string> = { limit: "100" };
  if (config.projectId) params.project = config.projectId;

  const response = await apiGet<TraceListResponse>(
    backendUrl,
    "/v1/runs",
    params,
    config,
  );
  const traces = response.data ?? [];
  const result = findByPrefix(traces, prefix, (t) => t.id);
  if (result.status === "none") {
    throw new Error(`Backend error 404: {"detail":"Trace not found"}`);
  }
  if (result.status === "ambiguous") {
    throw new Error(
      `Trace ID prefix "${prefix}" matches multiple traces: ${result.items
        .map((t) => t.id)
        .join(", ")}`,
    );
  }
  return result.item.id;
}

function printTraceDetail(trace: TraceDetail, calls: TraceCall[], verbose: boolean): void {
  const { run } = trace;
  const totalCost = trace.calls.reduce((s, c) => s + (c.cost ?? 0), 0);
  const totalTokens = trace.calls.reduce((s, c) => s + (c.total_tokens ?? 0), 0);
  const errorCount = trace.calls.filter((c) => c.level === "ERROR").length;
  const warnCount = trace.calls.filter((c) => c.level === "WARNING").length;

  console.log(bold(`Trace: ${run.id}`));
  console.log(`  Task:      ${run.task_id ?? run.flow_name ?? "-"}`);
  console.log(`  Status:    ${run.status}`);
  console.log(`  Duration:  ${run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : "-"}`);
  console.log(`  Calls:     ${trace.calls.length}${errorCount > 0 ? ` (${red(`${errorCount} errors`)})` : ""}${warnCount > 0 ? ` (${warnCount} warnings)` : ""}`);
  console.log(`  Cost:      ${formatCost(totalCost)}`);
  console.log(`  Tokens:    ${totalTokens.toLocaleString()}`);
  console.log(`  Created:   ${formatTime(run.created_at)}`);

  if (calls.length === 0) return;

  console.log("");
  console.log(bold("  Calls:"));
  for (const call of calls) {
    printCall(call, verbose);
  }
}

function levelIndicator(level: string): string {
  if (level === "ERROR") return red("✗");
  if (level === "WARNING") return dim("⚠");
  return " ";
}

function printCall(call: TraceCall, verbose: boolean): void {
  const indent = call.parent_call_id ? "    " : "  ";
  const li = levelIndicator(call.level);
  const step = (call.step_name ?? call.observation_type ?? "-").padEnd(24);
  const model = (call.model ?? "-").slice(0, 22).padEnd(22);
  const latency = call.latency_ms != null ? `${(call.latency_ms / 1000).toFixed(1)}s`.padStart(6) : "     -";
  const cost = formatCost(call.cost).padStart(10);
  const tokens = call.total_tokens != null ? call.total_tokens.toLocaleString().padStart(8) : "       -";
  const ttft = call.time_to_first_token_ms != null ? ` ttft:${(call.time_to_first_token_ms / 1000).toFixed(1)}s` : "";

  console.log(`${dim(indent)}${li} ${step} ${dim(model)} ${latency}  ${cost}  ${tokens}${dim(ttft)}`);

  // Token split
  if (call.prompt_tokens != null || call.completion_tokens != null) {
    const pt = call.prompt_tokens ?? 0;
    const ct = call.completion_tokens ?? 0;
    console.log(dim(`${indent}    tokens: ${pt.toLocaleString()} prompt + ${ct.toLocaleString()} completion`));
  }

  // Tool calls
  if (call.tool_name) {
    console.log(dim(`${indent}    tool: ${call.tool_name}`));
    if (call.tool_parameters) {
      const params = truncateJson(call.tool_parameters, 200);
      console.log(dim(`${indent}    args: ${params}`));
    }
    if (call.tool_result != null) {
      const result = truncateJson(call.tool_result, 200);
      console.log(dim(`${indent}    result: ${result}`));
    }
  }

  // Status messages (non-success)
  if (call.status_message && call.status_message !== "success") {
    console.log(red(`${indent}    ↳ ${call.status_message.slice(0, 200)}`));
  }

  // Verbose: show input/output
  if (verbose) {
    if (call.messages && Array.isArray(call.messages) && call.messages.length > 0) {
      console.log(dim(`${indent}    messages:`));
      for (const msg of call.messages) {
        printMessage(msg, indent);
      }
    } else if (call.input != null) {
      console.log(dim(`${indent}    input:`));
      console.log(dim(`${indent}      ${truncateJson(call.input, 500)}`));
    }
    if (call.output != null) {
      console.log(dim(`${indent}    output:`));
      console.log(dim(`${indent}      ${truncateJson(call.output, 500)}`));
    }
  }
}

function printMessage(msg: unknown, indent: string): void {
  if (typeof msg !== "object" || msg === null) {
    console.log(dim(`${indent}      ${truncateJson(msg, 200)}`));
    return;
  }
  const m = msg as Record<string, unknown>;
  const role = m.role ?? "?";
  const content = typeof m.content === "string" ? m.content : truncateJson(m.content, 300);
  console.log(dim(`${indent}      [${role}] ${String(content).slice(0, 300)}`));
}

function truncateJson(value: unknown, maxLen: number): string {
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 0);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}
