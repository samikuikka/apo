import { parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatCost, formatDuration, formatJson, formatTime, passFail } from "../lib/format.ts";
import { apiGet, AuthError } from "../lib/api.ts";
import { findByPrefix } from "../lib/prefix.ts";

type TaskRunSummary = {
  id: string;
  task_id: string;
  task_path: string;
  adapter_name: string | null;
  status: string;
  pass_result: boolean | null;
  error_message: string | null;
  total_cost: number | null;
  trace_run_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
};

type BatchDetail = {
  id: string;
  project: string | null;
  status: string;
  total_tasks: number;
  passed_tasks: number;
  failed_tasks: number;
  errored_tasks: number;
  total_cost: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  trigger: {
    source: string | null;
    actor: string | null;
    hostname: string | null;
    entrypoint: string | null;
  } | null;
  task_runs: TaskRunSummary[];
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const batchIdPrefix = requirePositional(positional, 0, "batch-id");
  const watch = flags.watch === true;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let resolvedBatchId = batchIdPrefix;
  if (batchIdPrefix.length < 32) {
    try {
      resolvedBatchId = await resolveBatchIdByPrefix(
        config.backendUrl,
        batchIdPrefix,
        config,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404")) {
        console.error(`Batch run not found: ${batchIdPrefix}`);
      } else if (error instanceof AuthError || message.startsWith("Backend error") || message.includes("matches multiple")) {
        console.error(message);
      } else {
        console.error(`Cannot connect to backend at ${config.backendUrl}`);
        console.error(dim(message));
      }
      return 2;
    }
  }

  while (true) {
    let batch: BatchDetail;
    try {
      batch = await apiGet<BatchDetail>(
        config.backendUrl,
        `/v1/agent-task-batch-runs/${resolvedBatchId}`,
        undefined,
        config,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AuthError || message.startsWith("Backend error")) {
        console.error(message);
      } else {
        console.error(`Cannot connect to backend at ${config.backendUrl}`);
        console.error(dim(message));
      }
      return 2;
    }

    if (config.json) {
      console.log(formatJson(batch));
      if (!watch || !["running", "queued"].includes(batch.status)) return 0;
      await sleep(3000);
      continue;
    }

    if (watch) {
      console.clear();
    }
    printBatchDetail(batch);

    if (!watch || !["running", "queued"].includes(batch.status)) {
      return 0;
    }
    await sleep(3000);
  }
}

async function resolveBatchIdByPrefix(
  backendUrl: string,
  prefix: string,
  config: ReturnType<typeof resolveConfig>,
): Promise<string> {
  const params: Record<string, string> = {};
  if (config.projectId) params.project = config.projectId;

  const batches = await apiGet<Array<{ id: string }>>(
    backendUrl,
    "/v1/agent-task-batch-runs",
    params,
    config,
  );
  const result = findByPrefix(batches, prefix, (b) => b.id);
  if (result.status === "none") {
    throw new Error(`Backend error 404: {"detail":"Batch run not found"}`);
  }
  if (result.status === "ambiguous") {
    throw new Error(
      `Batch ID prefix "${prefix}" matches multiple batches: ${result.items
        .map((b) => b.id)
        .join(", ")}`,
    );
  }
  return result.item.id;
}

function printBatchDetail(batch: BatchDetail): void {
  console.log(bold(`Batch: ${batch.id}`));
  console.log(`  Status:   ${batch.status}`);
  console.log(`  Tasks:    ${batch.total_tasks}`);
  console.log(`  Passed:   ${batch.passed_tasks}`);
  console.log(`  Failed:   ${batch.failed_tasks}`);
  console.log(`  Errored:  ${batch.errored_tasks}`);
  console.log(`  Cost:     ${formatCost(batch.total_cost)}`);
  console.log(`  Created:  ${formatTime(batch.created_at)}`);
  console.log(`  Source:   ${formatTriggerOpt(batch.trigger)}`);
  if (batch.started_at) {
    console.log(`  Started:  ${formatTime(batch.started_at)}`);
  }
  if (batch.completed_at) {
    console.log(`  Completed: ${formatTime(batch.completed_at)}`);
  }

  if (batch.task_runs.length > 0) {
    console.log(bold("\n  Task Runs:"));
    for (const tr of batch.task_runs) {
      const result = tr.pass_result === null ? "-" : passFail(tr.pass_result);
      const cost = tr.total_cost != null ? dim(` ${formatCost(tr.total_cost)}`) : "";
      const duration = formatDuration(tr.started_at, tr.completed_at);
      const adapter = tr.adapter_name ? dim(` [${tr.adapter_name}]`) : "";
      console.log(`    ${result} ${tr.task_id} (${tr.status})${adapter}${dim(` ${duration}`)}${cost}`);

      if (tr.total_checks > 0) {
        console.log(dim(`        checks: ${tr.passed_checks}/${tr.total_checks} passed`));
      }
      if (tr.trace_run_id) {
        console.log(dim(`        trace: ${tr.trace_run_id}`));
      }
      if (tr.error_message) {
        const lines = tr.error_message.split("\n").map((l) => l.trim()).filter(Boolean);
        const errorLine = lines.find((l) =>
          /^[\w ]*Error\b.*:/.test(l) && !l.startsWith("at ") && !l.startsWith("node:")
        ) ?? lines.find((l) => !l.startsWith("at ") && !l.includes("Warning") && !l.includes("Reparsing")) ?? lines[0];
        console.log(dim(`        ${errorLine.slice(0, 200)}`));
      }
    }
  }
}

function formatTriggerOpt(trigger: BatchDetail["trigger"]): string {
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
