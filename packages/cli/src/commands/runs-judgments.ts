/**
 * `apo runs judgments <run-id> [judgment-id]` — list a run's judgments
 * (original first, rejudges newest first), or read one judgment's full
 * check evidence (issue #159).
 */

import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson, formatTime, yellow } from "../lib/format.ts";
import { formatChecks } from "../lib/checks-format.ts";
import { apiGet } from "../lib/api.ts";
import { resolveRunId } from "../lib/runs-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";

interface JudgmentSummary {
  id: string;
  task_run_id: string;
  trigger: "original" | "rejudge";
  label: string | null;
  judge_model: string | null;
  judge_base_url: string | null;
  task_definition_revision_id: string | null;
  definition_revision_matches_run: boolean | null;
  samples: number;
  pass_result: boolean | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  errored_checks?: number;
  created_at: string | null;
  checks: Array<Record<string, unknown>> | null;
  stability: Array<{ check_id: string; passes: number; samples: number; errored?: number }> | null;
}

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const input = positional[0];
  if (!input) {
    console.error("Missing required argument: <run-id>");
    console.error(dim("Usage: apo runs judgments <run-id> [judgment-id]"));
    return 2;
  }
  const judgmentId = positional[1];

  let runId: string;
  try {
    runId = await resolveRunId(config.backendUrl, input, config, getFlagValue(flags, "task"));
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (judgmentId) {
    return showJudgment(config.backendUrl, runId, judgmentId, config);
  }

  let body: { task_run_id: string; judgments: JudgmentSummary[] };
  try {
    body = await apiGet<{ task_run_id: string; judgments: JudgmentSummary[] }>(
      config.backendUrl,
      `/v1/agent-task-runs/${runId}/judgments`,
      undefined,
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson(body.judgments));
    return 0;
  }

  console.log(bold(`Judgments on run ${runId}:`));
  if (body.judgments.length === 0) {
    console.log(dim("  none"));
    return 0;
  }
  for (const judgment of body.judgments) {
    printSummary(judgment, runId);
  }
  console.log(dim(`\nRead one judgment's checks: apo runs judgments ${runId} <judgment-id>`));
  return 0;
}

async function showJudgment(
  backendUrl: string,
  runId: string,
  judgmentId: string,
  config: ReturnType<typeof resolveConfig>,
): Promise<number> {
  let judgment: JudgmentSummary;
  try {
    judgment = await apiGet<JudgmentSummary>(
      backendUrl,
      `/v1/agent-task-runs/${runId}/judgments/${judgmentId}`,
      undefined,
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson(judgment));
    return 0;
  }

  printSummary(judgment, runId, { withHint: false });
  if (judgment.checks && judgment.checks.length > 0) {
    console.log(bold("\n  Checks:"));
    console.log(formatChecks(judgment.checks as never, false));
  }
  if (judgment.stability && judgment.stability.length > 0) {
    console.log(bold(`\n  Stability (${judgment.samples} samples):`));
    for (const entry of judgment.stability) {
      // Errored samples produced no verdict — they shrink the judged
      // denominator instead of reading as flaky fails (issue #323).
      const errored = entry.errored ?? 0;
      const judged = entry.samples - errored;
      const stable = entry.passes === judged || entry.passes === 0;
      const marker = stable ? "" : yellow("  ← unstable");
      const erroredNote = errored > 0 ? yellow(` (${errored} no verdict)`) : "";
      console.log(
        `    ${entry.check_id.padEnd(40)} ${entry.passes}/${judged}${erroredNote}${marker}`,
      );
    }
  }
  return 0;
}

function printSummary(judgment: JudgmentSummary, runId: string, opts: { withHint?: boolean } = {}): void {
  const judge = judgment.judge_model ?? "-";
  const score = `${judgment.passed_checks}/${judgment.total_checks}`;
  const erroredNote =
    judgment.errored_checks && judgment.errored_checks > 0
      ? yellow(` · ${judgment.errored_checks} no verdict`)
      : "";
  const samples = judgment.samples > 1 ? ` · ${judgment.samples} samples` : "";
  const label = judgment.label ? yellow(` · ${judgment.label}`) : "";
  const revision = judgment.definition_revision_matches_run === false
    ? yellow(` · revision ${judgment.task_definition_revision_id} (NOT the run's pinned revision)`)
    : "";
  const created = judgment.created_at ? formatTime(judgment.created_at) : "-";
  console.log(
    `\n  ${bold(judgment.id)} ${dim(`(${judgment.trigger})`)} — ${score} checks${erroredNote}${samples}${label}${revision}`,
  );
  console.log(`    Judge: ${judge}   Created: ${created}`);
  if (opts.withHint !== false && judgment.trigger === "original" && judgment.id === runId) {
    console.log(dim("    (the run's own verdict — trigger=original)"));
  }
}
