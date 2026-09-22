import { getBoolFlag, parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatCost, formatJson, formatTime, red } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { findByPrefix } from "../lib/prefix.ts";
import { reportCommandError } from "../lib/command-error.ts";

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
  /** Normalized usage map (UsageKey -> token count); a missing "reasoning"
   * key means the provider did not report the dimension. */
  raw_usage?: Record<string, number> | null;
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
  /** Raw canonical OtlpSpanDB attributes — present with --verbose or --json. */
  attributes?: Record<string, unknown> | null;
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
  /** Per-category evidence availability, mirroring the projection snapshot. */
  capabilities?: Record<string, string>;
};

/** Which per-call sections to render, and how much of the content to show. */
type CallView = {
  /** Effective --verbose: render diagnostics + content sections. */
  verbose: boolean;
  /** Char cap per message; Infinity with --full or --call. */
  messageCap: number;
  /** Char cap for input/output blobs; Infinity with --full or --call. */
  ioCap: number;
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const traceId = requirePositional(positional, 0, "trace-id");
  const verbose = getBoolFlag(flags, "verbose") || flags.v === true;
  const errorsOnly = getBoolFlag(flags, "errors-only");
  // getBoolFlag (not `=== true`) so `--full` and `--full=true` both work —
  // parseArgs stores the inline `=true` form as the string "true".
  const full = getBoolFlag(flags, "full");
  const callFlag = flags.call;
  if (callFlag === true || callFlag === "") {
    throw new Error("--call requires a call id (or unique id prefix)");
  }
  const callSelector = typeof callFlag === "string" ? callFlag : null;
  const maxChars = parseMaxChars(flags["max-chars"], full);

  // --full / --max-chars / --call size the content sections, so they imply
  // the verbose view — caps on sections that don't render would be a no-op.
  const view: CallView = {
    verbose: verbose || full || maxChars !== null || callSelector !== null,
    messageCap: maxChars ?? (full || callSelector !== null ? Infinity : DEFAULT_MESSAGE_CAP),
    ioCap: maxChars ?? (full || callSelector !== null ? Infinity : DEFAULT_IO_CAP),
  };

  let resolvedTraceId = traceId;
  if (traceId.length < 20) {
    try {
      resolvedTraceId = await resolveTraceIdByPrefix(config.backendUrl, traceId, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404")) {
        console.error(`Trace not found: ${traceId}`);
        return 2;
      }
      return reportCommandError(error, config.backendUrl);
    }
  }

  let trace: TraceDetail;
  try {
    const params: Record<string, string> = {};
    if (config.projectId) params.project = config.projectId;
    // The backend omits per-call `messages` (duplicates input/output content)
    // and raw span `attributes` (heavy) by default; the verbose view renders
    // them, so opt in. --json is the everything-mode: it opts in too, so the
    // raw dump genuinely carries the content the text view previews.
    // Comma-separated — the backend checks each token by substring.
    if (view.verbose || config.json) params.include = "messages,attributes";
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

  // --call picks one generation to read in full; resolve it before the --json
  // escape hatch so a typo'd selector fails loudly even in raw-JSON mode.
  let selected: TraceCall[] | null = null;
  if (callSelector !== null) {
    const result = findByPrefix(trace.calls, callSelector, (c) => c.id);
    if (result.status === "none") {
      console.error(`Call not found: ${callSelector}`);
      return 2;
    }
    if (result.status === "ambiguous") {
      // Cap the list — a short prefix on a large trace would otherwise print
      // every call id in one line.
      const ids = result.items.map((c) => c.id);
      const shown = ids.length > 10 ? `${ids.slice(0, 10).join(", ")}, …` : ids.join(", ");
      console.error(`Call prefix "${callSelector}" matches ${ids.length} calls: ${shown}`);
      return 2;
    }
    selected = [result.item];
  }

  if (config.json) {
    // Raw escape hatch: always the full trace, unaffected by --call.
    console.log(formatJson(trace));
    return 0;
  }

  // A resolved --call wins over --errors-only: it names the exact call to read.
  const calls =
    selected
    ?? (errorsOnly
      ? trace.calls.filter((c) => c.level === "ERROR" || c.level === "WARNING")
      : trace.calls);

  printTraceDetail(trace, calls, view);
  return 0;
}

type TraceListResponse = {
  data: Array<{ id: string }>;
  total_count: number;
};

/**
 * Parse --max-chars into a content cap. Junk and the --full combination are
 * rejected before any request fires, so a doomed invocation costs no fetch.
 */
function parseMaxChars(flag: string | boolean | undefined, full: boolean): number | null {
  if (flag === undefined) return null;
  if (full) {
    throw new Error("--full and --max-chars are mutually exclusive");
  }
  if (flag === true) {
    throw new Error("--max-chars requires a positive integer, e.g. --max-chars 2000");
  }
  const value = Number(flag);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--max-chars requires a positive integer, got "${flag}"`);
  }
  return value;
}

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

function printTraceDetail(trace: TraceDetail, calls: TraceCall[], view: CallView): void {
  const { run } = trace;
  const totalCost = trace.calls.reduce((s, c) => s + (c.cost ?? 0), 0);
  const totalTokens = trace.calls.reduce((s, c) => s + (c.total_tokens ?? 0), 0);
  const errorCount = trace.calls.filter((c) => c.level === "ERROR").length;
  const warnCount = trace.calls.filter((c) => c.level === "WARNING").length;

  // Issue #309 rollups — model-call facts, so GENERATION observations only:
  // tool/structural rows carry latencies too (the agent-task root span's
  // latency is the run's whole wall clock), and maxing or summing those
  // would crown a tool as the "slowest model call".
  const generations = trace.calls.filter((c) => c.observation_type === "GENERATION");
  // Reasoning reads the normalized raw_usage dimension; absent means the
  // provider never reported it — unknown, not zero.
  const reporting = generations.filter((c) => c.raw_usage && "reasoning" in c.raw_usage);
  const timed = generations.filter((c) => c.latency_ms != null);

  console.log(bold(`Trace: ${run.id}`));
  console.log(`  Task:      ${run.task_id ?? run.flow_name ?? "-"}`);
  console.log(`  Status:    ${run.status}`);
  console.log(`  Duration:  ${run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : "-"}`);
  console.log(`  Calls:     ${trace.calls.length}${errorCount > 0 ? ` (${red(`${errorCount} errors`)})` : ""}${warnCount > 0 ? ` (${warnCount} warnings)` : ""}`);
  console.log(`  Cost:      ${formatCost(totalCost)}`);
  console.log(`  Tokens:    ${totalTokens.toLocaleString()}`);
  if (reporting.length > 0) {
    const totalReasoning = reporting.reduce((s, c) => s + (c.raw_usage!.reasoning ?? 0), 0);
    const deepest = reporting.reduce((a, b) =>
      (b.raw_usage!.reasoning ?? 0) > (a.raw_usage!.reasoning ?? 0) ? b : a);
    console.log(
      `  Reasoning: ${totalReasoning.toLocaleString()} tok ${dim(`· max ${deepest.raw_usage!.reasoning.toLocaleString()} in one call (observation ${deepest.id})`)}`,
    );
  }
  if (timed.length > 0) {
    const slowest = timed.reduce((a, b) => (b.latency_ms! > a.latency_ms! ? b : a));
    const modelTime = timed.reduce((s, c) => s + c.latency_ms!, 0);
    console.log(
      `  Slowest call: ${(slowest.latency_ms! / 1000).toFixed(1)}s ${dim(`(observation ${slowest.id})`)}`,
    );
    console.log(
      `  Model time: ${(modelTime / 1000).toFixed(1)}s ${dim("(sum of generation latencies — excludes tool/harness time)")}`,
    );
  }
  console.log(`  Created:   ${formatTime(run.created_at)}`);
  if (trace.capabilities) {
    // Which evidence categories this trace's projection carries — an
    // `unsupported` assertion verdict means the category reads "unavailable"
    // here, not that the assertion is wrong (issue #164).
    const caps = Object.entries(trace.capabilities)
      .map(([name, state]) => `${name}:${state}`)
      .join("  ");
    console.log(`  Evidence:  ${caps}`);
  }

  if (calls.length === 0) return;

  console.log("");
  console.log(bold("  Calls:"));
  // Model names are never truncated: size the column to the longest model
  // actually present so the full identifier stays greppable.
  const modelWidth = Math.max(...calls.map((c) => (c.model ?? "-").length), 1);
  for (const call of calls) {
    printCall(call, view, modelWidth);
  }
}

function levelIndicator(level: string): string {
  if (level === "ERROR") return red("✗");
  if (level === "WARNING") return dim("⚠");
  return " ";
}

function printCall(call: TraceCall, view: CallView, modelWidth: number): void {
  const indent = call.parent_call_id ? "    " : "  ";
  const li = levelIndicator(call.level);
  const step = (call.step_name ?? call.observation_type ?? "-").padEnd(24);
  const model = (call.model ?? "-").padEnd(modelWidth);
  const latency = call.latency_ms != null ? `${(call.latency_ms / 1000).toFixed(1)}s`.padStart(6) : "     -";
  const cost = formatCost(call.cost).padStart(10);
  const tokens = call.total_tokens != null ? call.total_tokens.toLocaleString().padStart(8) : "       -";
  const ttft = call.time_to_first_token_ms != null ? ` ttft:${(call.time_to_first_token_ms / 1000).toFixed(1)}s` : "";

  // Verbose appends the call id: --call takes these ids, so the tree itself
  // must show them — otherwise picking one out means a --json dump.
  const idSuffix = view.verbose ? dim(`  ${call.id}`) : "";
  console.log(`${dim(indent)}${li} ${step} ${dim(model)} ${latency}  ${cost}  ${tokens}${dim(ttft)}${idSuffix}`);

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

  // Verbose: raw span attributes — answers "did my OTLP attribute arrive,
  // and next to the resolved observation_type above, what did it map to"
  // (issue #164). Stays compact even with --full: the readable copy lives
  // in messages/output below; attrs only proves the attribute arrived.
  if (view.verbose) {
    console.log(dim(`${indent}    type: ${call.observation_type}`));
    if (call.attributes) {
      console.log(dim(`${indent}    attrs: ${truncateJson(call.attributes, 400)}`));
    }
  }

  // Verbose: show input/output, capped per the view (issue #308: --full /
  // --max-chars / --call lift or resize the caps so full reasoning is
  // readable without dumping the whole trace as --json).
  if (view.verbose) {
    if (call.messages && Array.isArray(call.messages) && call.messages.length > 0) {
      console.log(dim(`${indent}    messages:`));
      for (const msg of call.messages) {
        printMessage(msg, indent, view.messageCap);
      }
    } else if (call.input != null) {
      console.log(dim(`${indent}    input:`));
      console.log(dim(`${indent}      ${truncateJson(call.input, view.ioCap)}`));
    }
    if (call.output != null) {
      console.log(dim(`${indent}    output:`));
      console.log(dim(`${indent}      ${truncateJson(call.output, view.ioCap)}`));
    }
  }
}

function printMessage(msg: unknown, indent: string, cap: number): void {
  if (typeof msg !== "object" || msg === null) {
    console.log(dim(`${indent}      ${truncateJson(msg, cap)}`));
    return;
  }
  const m = msg as Record<string, unknown>;
  const role = m.role ?? "?";
  const content = typeof m.content === "string" ? m.content : truncateJson(m.content, cap);
  console.log(dim(`${indent}      [${role}] ${String(content).slice(0, cap)}`));
}

/** Default content previews keep `traces show --verbose` compact in a terminal. */
const DEFAULT_MESSAGE_CAP = 300;
const DEFAULT_IO_CAP = 500;

function truncateJson(value: unknown, maxLen: number): string {
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 0);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}
