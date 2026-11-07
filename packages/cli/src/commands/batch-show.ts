import { parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import {
  bold,
  dim,
  formatCost,
  formatDuration,
  formatJson,
  formatTime,
  formatTrigger,
  type TriggerParts,
  terminalSafeDeep,
} from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { resolveBatchId } from "../lib/batch-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";
import { formatRunResult, isJudgeNoVerdictRun } from "../lib/checks-format.ts";
import { isBatchLive } from "../lib/run-status.ts";

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
  errored_checks?: number;
  no_verdict_reason?: "judge" | "generations" | "executor" | null;
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
  trigger: TriggerParts | null;
  /** The authenticated User who asked for the Batch; null on older rows. */
  requested_by_label?: string | null;
  task_runs: TaskRunSummary[];
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const batchIdPrefix = requirePositional(positional, 0, "batch-id");
  const watch = flags.watch === true;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let resolvedBatchId: string;
  try {
    resolvedBatchId = await resolveBatchId(
      config.backendUrl,
      batchIdPrefix,
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
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
      return reportCommandError(error, config.backendUrl);
    }

    if (config.json) {
      console.log(formatJson(batch));
      if (!watch || !isBatchLive(batch.status)) return 0;
      await sleep(3000);
      continue;
    }

    if (watch) {
      console.clear();
    }
    printBatchDetail(terminalSafeDeep(batch));

    if (!watch || !isBatchLive(batch.status)) {
      return 0;
    }
    await sleep(3000);
  }
}

function printBatchDetail(batch: BatchDetail): void {
  console.log(bold(`Batch: ${batch.id}`));
  console.log(`  Status:   ${batch.status}`);
  console.log(`  Tasks:    ${batch.total_tasks}`);
  console.log(`  Passed:   ${batch.passed_tasks}`);
  console.log(`  Failed:   ${batch.failed_tasks}`);
  console.log(`  Errored:  ${batch.errored_tasks}`);
  for (const line of formatNeverStarted(batch)) console.log(line);
  console.log(`  Cost:     ${formatCost(batch.total_cost)}`);
  console.log(`  Created:  ${formatTime(batch.created_at)}`);
  console.log(`  Source:   ${batch.trigger ? formatTrigger(batch.trigger) : "-"}`);
  if (batch.requested_by_label) {
    console.log(`  Requested by: ${batch.requested_by_label}`);
  }
  if (batch.started_at) {
    console.log(`  Started:  ${formatTime(batch.started_at)}`);
  }
  if (batch.completed_at) {
    console.log(`  Completed: ${formatTime(batch.completed_at)}`);
  }

  if (batch.task_runs.length > 0) {
    console.log(bold("\n  Task Runs:"));
    for (const tr of batch.task_runs) {
      const result = formatRunResult(tr);
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
      if (tr.error_message && isJudgeNoVerdictRun(tr)) {
        // Only the rule's own line, which says why; a caller's note after it
        // is left to `apo runs show`.
        console.log(dim(`        ${tr.error_message.split("\n")[0]!.slice(0, 200)}`));
      } else if (tr.error_message) {
        const lines = tr.error_message.split("\n").map((l) => l.trim()).filter(Boolean);
        const errorLine = lines.find((l) =>
          /^[\w ]*Error\b.*:/.test(l) && !l.startsWith("at ") && !l.startsWith("node:")
        ) ?? lines.find((l) => !l.startsWith("at ") && !l.includes("Warning") && !l.includes("Reparsing")) ?? lines[0];
        // A corrected PASS keeps the executor's note; it is not an error.
        const label = tr.pass_result === true ? "note: " : "";
        console.log(dim(`        ${label}${errorLine.slice(0, 200)}`));
      }
    }
  }
}

/**
 * A run that errored before its task code started counts as "Errored" above,
 * which reads as the task failing. That covers queue TTL expiry, cancellation
 * while queued, executor retirement, removal from the catalog, and an executor
 * failing while preparing. Say how many never ran, grouped by the recorded reason.
 */
export function formatNeverStarted(batch: Pick<BatchDetail, "task_runs">): string[] {
  const neverStarted = batch.task_runs.filter((tr) => tr.started_at == null && tr.status === "error");
  if (neverStarted.length === 0) return [];
  const byReason = new Map<string, number>();
  for (const tr of neverStarted) {
    const firstLine = tr.error_message?.split("\n").map((l) => l.trim()).find(Boolean);
    const reason = firstLine ? firstLine.slice(0, 120) : "no reason recorded";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const total = batch.task_runs.length;
  const reasons = [...byReason].sort((a, b) => b[1] - a[1]);
  if (reasons.length === 1) {
    return [`  ${neverStarted.length} of ${total} never started: ${reasons[0]![0]}`];
  }
  return [
    `  ${neverStarted.length} of ${total} never started:`,
    ...reasons.map(([reason, n]) => `    ${n}× ${reason}`),
  ];
}
