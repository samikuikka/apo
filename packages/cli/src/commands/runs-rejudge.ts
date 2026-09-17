/**
 * `apo runs rejudge <run-id>` — replay Phase 2 of a completed run against
 * its stored deliverables, without re-running the agent (issue #159).
 *
 * Fetches the run's deliverables + pinned definition revision from the
 * backend, executes the eval's checks HERE (the backend never executes task
 * code), and records the outcome as a new judgment. The original verdict is
 * never touched.
 *
 * Judge cost warning: this makes real LLM calls for every `t.judge`
 * judged test — including with --dry-run, which only skips RECORDING.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, getFlagValue, getBoolFlag } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson, passFail, yellow } from "../lib/format.ts";
import { formatChecks, secondJudgeSummary } from "../lib/checks-format.ts";
import { apiGet, apiPost } from "../lib/api.ts";
import { resolveRunId } from "../lib/runs-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";
import type { RejudgeOutcome } from "@apo-ai/sdk/agent-task";

const MAX_SAMPLES = 50;

interface RunDetailHead {
  id: string;
  task_id: string;
  task_path: string | null;
}

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const input = positional[0];
  if (!input) {
    console.error("Missing required argument: <run-id>");
    console.error(
      dim("Usage: apo runs rejudge <run-id> [--judge-model <m>] [--samples <n>] [--label <text>] [--dry-run]"),
    );
    return 2;
  }

  const samplesArg = getFlagValue(flags, "samples");
  const samples = samplesArg ? Number.parseInt(samplesArg, 10) : 1;
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
    console.error(`--samples must be an integer between 1 and ${MAX_SAMPLES}`);
    return 2;
  }

  const dryRun = getBoolFlag(flags, "dry-run");
  const verbose = getBoolFlag(flags, "verbose");
  const exitStatus = getBoolFlag(flags, "exit-status");
  const label = getFlagValue(flags, "label");
  const taskFilter = getFlagValue(flags, "task");
  const judgeModel =
    getFlagValue(flags, "judge-model") ??
    process.env.AGENT_TASK_JUDGE_MODEL ??
    process.env.OPENROUTER_MODEL ??
    process.env.OPENAI_MODEL;
  const judgeBaseUrl =
    getFlagValue(flags, "judge-base-url") ??
    process.env.OPENROUTER_BASE_URL ??
    process.env.OPENAI_BASE_URL;
  const definitionRevision = getFlagValue(flags, "definition-revision");

  let runId: string;
  let head: RunDetailHead;
  try {
    runId = await resolveRunId(config.backendUrl, input, config, taskFilter);
    head = await apiGet<RunDetailHead>(config.backendUrl, `/v1/agent-task-runs/${runId}`, undefined, config);
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  // The stored revision pins only the eval file. A local checkout of the
  // task lets relative imports and `files/` fixtures resolve like a live
  // run; without one, only fully self-contained evals can replay.
  let taskDir: string | null;
  try {
    taskDir = resolveTaskDir(getFlagValue(flags, "task-dir"), head, config.taskRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const progress = (message: string): void => {
    process.stderr.write(dim(`rejudge: ${message}\n`));
  };

  let outcome: RejudgeOutcome;
  try {
    const { rejudgeTaskRun } = await import("@apo-ai/sdk/agent-task");
    outcome = await rejudgeTaskRun(
      runId,
      { backendUrl: config.backendUrl, authToken: config.apiKey ?? "" },
      {
        ...(judgeModel ? { judge: { model: judgeModel, ...(judgeBaseUrl ? { baseURL: judgeBaseUrl } : {}) } } : {}),
        samples,
        ...(definitionRevision ? { definitionRevisionId: definitionRevision } : {}),
        ...(taskDir ? { taskDir } : {}),
        onProgress: progress,
      },
    );
  } catch (error) {
    // Replay refusals (non-terminal run, deliverables not ready, eval that
    // needs its task dir) are deliberate operator-facing failures.
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 2;
  }

  let judgmentId: string | null = null;
  if (!dryRun) {
    try {
      const created = await apiPost<{ id: string }>(
        config.backendUrl,
        `/v1/agent-task-runs/${runId}/judgments`,
        {
          ...(label ? { label } : {}),
          judge_model: outcome.judge?.model ?? null,
          judge_base_url: outcome.judge?.baseURL ?? null,
          task_definition_revision_id: outcome.definitionRevisionId,
          samples: outcome.samples,
          checks: outcome.checks,
          stability: outcome.samples > 1 ? outcome.stability : null,
        },
        config,
      );
      judgmentId = created.id;
    } catch (error) {
      return reportCommandError(error, config.backendUrl);
    }
  }

  if (config.json) {
    console.log(formatJson({ ...outcome, dry_run: dryRun, judgment_id: judgmentId }));
  } else {
    printOutcome(outcome, { verbose, dryRun, judgmentId, runId, taskDir });
  }

  if (exitStatus) {
    return outcome.pass ? 0 : 1;
  }
  return 0;
}

function resolveTaskDir(
  flagValue: string | undefined,
  head: RunDetailHead,
  taskRoot: string | undefined,
): string | null {
  if (flagValue) {
    if (!existsSync(flagValue)) {
      throw new Error(`--task-dir does not exist: ${flagValue}`);
    }
    return flagValue;
  }
  if (taskRoot) {
    const byTaskId = join(taskRoot, head.task_id);
    if (existsSync(byTaskId)) return byTaskId;
  }
  if (head.task_path && existsSync(head.task_path)) {
    return head.task_path;
  }
  return null;
}

function printOutcome(
  outcome: RejudgeOutcome,
  meta: {
    verbose: boolean;
    dryRun: boolean;
    judgmentId: string | null;
    runId: string;
    taskDir: string | null;
  },
): void {
  console.log(bold(`Re-judged run: ${outcome.runId}`));
  console.log(`  Task:     ${outcome.taskId}`);
  console.log(
    `  Revision: ${outcome.definitionRevisionId}${
      outcome.definitionRevisionIsPinned
        ? dim(" (the run's pinned revision)")
        : yellow(" (NOT the run's pinned revision — not comparable to the original verdict)")
    }`,
  );
  console.log(`  Judge:    ${outcome.judge?.model ?? dim("(none configured — t.judge checks fail with guidance)")}`);
  if (outcome.judge?.baseURL) {
    console.log(`  Base URL: ${outcome.judge.baseURL}`);
  }
  if (outcome.samples > 1) {
    console.log(`  Samples:  ${outcome.samples}`);
  }
  if (!outcome.traceSnapshotAvailable) {
    console.log(
      yellow("  Trace:    unavailable — trajectory assertions (t.calledTool, …) recorded as unsupported"),
    );
  }
  console.log(`  Task dir: ${meta.taskDir ?? dim("none found — replayed from an isolated scaffold")}`);

  console.log(bold("\n  Checks:"));
  console.log(formatChecks(outcome.checks as never, meta.verbose));
  const sjSummary = secondJudgeSummary(outcome.checks as never);
  if (sjSummary) console.log(dim(`\n  ${sjSummary}`));

  if (outcome.samples > 1) {
    console.log(bold(`\n  Stability (${outcome.samples} samples):`));
    for (const entry of outcome.stability) {
      const stable = entry.passes === entry.samples || entry.passes === 0;
      const marker = stable ? "" : yellow("  ← unstable");
      console.log(`    ${entry.check_id.padEnd(40)} ${entry.passes}/${entry.samples}${marker}`);
    }
  }

  const passed = outcome.checks.filter((c) => c.pass).length;
  console.log(
    `\n  Verdict:  ${passed}/${outcome.checks.length} checks passed — ${passFail(outcome.pass)}`,
  );

  if (meta.dryRun) {
    console.log(dim("  Dry run — no judgment recorded."));
  } else if (meta.judgmentId) {
    console.log(
      `  Recorded judgment ${meta.judgmentId} ${dim(`(apo runs judgments ${meta.runId})`)}`,
    );
  }
}
