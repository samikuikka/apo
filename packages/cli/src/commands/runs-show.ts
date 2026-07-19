import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatCost, formatJson, formatTime, passFail } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { findByPrefix } from "../lib/prefix.ts";
import type { CheckResult } from "../lib/agent-task-types.ts";
import { formatChecks } from "../lib/checks-format.ts";

type RunDetail = {
  id: string;
  task_id: string;
  task_path: string;
  batch_run_id: string;
  adapter_name: string;
  status: string;
  pass_result: boolean | null;
  started_at: string;
  completed_at: string | null;
  trace_run_id: string | null;
  error_message: string | null;
  total_cost: number | null;
  total_tokens: number | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  trigger: {
    source: string | null;
    actor: string | null;
    hostname: string | null;
    entrypoint: string | null;
  } | null;
  checks_json: CheckResult[] | null;
  deliverables_json: Record<string, unknown> | null;
  transcript_json: Record<string, unknown> | null;
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const verbose = flags.verbose === true || flags.v === true;
  const exitStatus = flags["exit-status"] === true;
  const taskFilter = getFlagValue(flags, "task");

  const input = positional[0];
  const wantLatest = !input || input === "last";

  let resolvedRunId: string;
  let showedLatest = false;

  if (wantLatest) {
    showedLatest = true;
    try {
      resolvedRunId = await resolveLatestRunId(
        config.backendUrl,
        config,
        taskFilter,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "NO_RUNS") {
        const scope = taskFilter ? ` for task "${taskFilter}"` : "";
        console.error(`No runs found${scope}. Run 'apo task run <task-id>' to create one.`);
        return 2;
      }
      console.error(`Cannot connect to backend at ${config.backendUrl}`);
      console.error(dim(message));
      return 2;
    }
  } else {
    resolvedRunId = input;
    if (input.length < 32) {
      try {
        resolvedRunId = await resolveRunIdByPrefix(
          config.backendUrl,
          input,
          config,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("404")) {
          console.error(`Run not found: ${input}`);
        } else if (message.startsWith("Backend error") || message.includes("timed out") || message.includes("Cannot connect") || message.includes("matches multiple")) {
          console.error(message);
        } else {
          console.error(`Cannot connect to backend at ${config.backendUrl}`);
          console.error(dim(message));
        }
        return 2;
      }
    }
  }

  let runDetail: RunDetail;
  try {
    runDetail = await apiGet<RunDetail>(
      config.backendUrl,
      `/v1/agent-task-runs/${resolvedRunId}`,
      undefined,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      console.error(`Run not found: ${resolvedRunId}`);
    } else if (message.startsWith("Backend error") || message.includes("timed out") || message.includes("Cannot connect")) {
      console.error(message);
    } else {
      console.error(`Cannot connect to backend at ${config.backendUrl}`);
      console.error(dim(message));
    }
    return 2;
  }

  if (config.json) {
    console.log(formatJson(runDetail));
  } else {
    if (showedLatest) {
      console.log(dim("(latest run)"));
    }
    printRunDetail(runDetail, verbose);
  }

  if (exitStatus) {
    return runDetail.pass_result === false ? 1 : 0;
  }
  return 0;
}

async function resolveRunIdByPrefix(
  backendUrl: string,
  prefix: string,
  config: ReturnType<typeof resolveConfig>,
): Promise<string> {
  const params: Record<string, string> = {};
  if (config.projectId) params.project = config.projectId;

  const runs = await apiGet<Array<{ id: string }>>(
    backendUrl,
    "/v1/agent-task-runs",
    params,
    config,
  );
  const result = findByPrefix(runs, prefix, (r) => r.id);
  if (result.status === "none") {
    throw new Error(`Backend error 404: {"detail":"Run not found"}`);
  }
  if (result.status === "ambiguous") {
    throw new Error(
      `Run ID prefix "${prefix}" matches multiple runs: ${result.items
        .map((r) => r.id)
        .join(", ")}`,
    );
  }
  return result.item.id;
}

async function resolveLatestRunId(
  backendUrl: string,
  config: ReturnType<typeof resolveConfig>,
  taskFilter?: string,
): Promise<string> {
  const params: Record<string, string> = { limit: "1" };
  if (config.projectId) params.project = config.projectId;
  if (taskFilter) params.task_id = taskFilter;

  const runs = await apiGet<Array<{ id: string }>>(
    backendUrl,
    "/v1/agent-task-runs",
    params,
    config,
  );
  if (runs.length === 0) {
    throw new Error("NO_RUNS");
  }
  return runs[0].id;
}

function printRunDetail(run: RunDetail, verbose: boolean): void {
  console.log(bold(`Run: ${run.id}`));
  console.log(`  Task:     ${run.task_id}`);
  console.log(`  Path:     ${run.task_path}`);
  if (run.batch_run_id) {
    console.log(`  Batch:    ${run.batch_run_id} ${dim("(apo batch show " + run.batch_run_id + ")")}`);
  }
  console.log(`  Adapter:  ${run.adapter_name}`);
  console.log(`  Status:   ${run.status}`);
  console.log(`  Result:   ${run.pass_result === null ? "-" : passFail(run.pass_result)}`);

  if (run.total_checks > 0) {
    console.log(`  Checks:   ${run.passed_checks}/${run.total_checks} passed (${run.failed_checks} failed)`);
  }

  console.log(`  Started:  ${formatTime(run.started_at)}`);
  if (run.completed_at) {
    console.log(`  Completed: ${formatTime(run.completed_at)}`);
  }
  console.log(`  Source:   ${formatTriggerOpt(run.trigger)}`);
  console.log(`  Cost:     ${formatCost(run.total_cost)}`);
  if (run.total_tokens != null && run.total_tokens > 0) {
    console.log(`  Tokens:   ${run.total_tokens.toLocaleString()}`);
  }
  if (run.trace_run_id) {
    console.log(`  Trace:    ${run.trace_run_id} ${dim("(apo traces show " + run.trace_run_id + ")")}`);
  }
  if (run.error_message) {
    console.log(`  Error:    ${run.error_message.slice(0, 500)}`);
  }

  if (run.checks_json && run.checks_json.length > 0) {
    console.log(bold("\n  Checks:"));
    console.log(formatChecks(run.checks_json, verbose));
  }

  if (verbose && run.deliverables_json) {
    console.log(bold("\n  Deliverables:"));
    const keys = Object.keys(run.deliverables_json);
    for (const key of keys) {
      const val = run.deliverables_json[key];
      const preview = typeof val === "string"
        ? val.slice(0, 200)
        : JSON.stringify(val, null, 0).slice(0, 300);
      console.log(dim(`    ${key}: ${preview}`));
    }
  }

  if (verbose && run.transcript_json) {
    console.log(bold("\n  Transcript:"));
    printTranscript(run.transcript_json);
  }
}

function printTranscript(transcript: Record<string, unknown>): void {
  const turns = transcript.turns ?? transcript.messages ?? transcript;
  if (Array.isArray(turns)) {
    for (const turn of turns) {
      if (typeof turn !== "object" || turn === null) continue;
      const t = turn as Record<string, unknown>;
      const role = t.role ?? t.actor ?? t.type ?? "?";
      const content = t.content ?? t.message ?? t.text ?? "";
      const preview = typeof content === "string"
        ? content.slice(0, 200)
        : JSON.stringify(content, null, 0).slice(0, 200);
      console.log(dim(`    [${role}] ${preview}`));
    }
  } else {
    const preview = JSON.stringify(transcript, null, 0).slice(0, 500);
    console.log(dim(`    ${preview}`));
  }
}

function formatTriggerOpt(trigger: RunDetail["trigger"]): string {
  if (!trigger) {
    return "-";
  }
  return formatTriggerLocal({
    source: trigger.source,
    actor: trigger.actor,
    hostname: trigger.hostname,
    entrypoint: trigger.entrypoint,
  });
}

function formatTriggerLocal(
  trigger: {
    source: string | null;
    actor: string | null;
    hostname: string | null;
    entrypoint: string | null;
  } | null,
): string {
  if (!trigger) {
    return "-";
  }

  const identity: string[] = [];
  if (trigger.source) identity.push(trigger.source);
  if (trigger.actor && trigger.actor !== trigger.hostname) {
    identity.push(trigger.actor);
  }
  if (trigger.hostname) identity.push(trigger.hostname);

  const identityStr = identity.length > 0 ? identity.join(" · ") : null;
  const entrypoint = trigger.entrypoint;

  if (identityStr && entrypoint) {
    return `${identityStr} · ${entrypoint}`;
  }
  return entrypoint ?? identityStr ?? "-";
}
