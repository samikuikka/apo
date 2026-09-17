import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatCost, formatJson, formatTime, passFail, yellow } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import type { CheckResult, DeliverableSummary } from "../lib/agent-task-types.ts";
import { formatChecks, NO_CHECKS_REGISTERED_MESSAGE, secondJudgeSummary } from "../lib/checks-format.ts";
import { conciseChecks, conciseDeliverables } from "../lib/runs-truncate.ts";
import { resolveRunIdByPrefix, resolveLatestRunId } from "../lib/runs-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";

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
  unpriced_call_count?: number;
  generation_execution?: GenerationExecution | null;
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
  deliverables?: DeliverableSummary[];
  run_configuration?: { model: string; effort?: string | null } | null;
  task_definition?: { id?: string } | null;
  judgments_count?: number;
  /** Tests whose effective result differs from the recorded one. */
  corrected_tests?: number;
  /** Issue #176: the attempt's last lease heartbeat (null for terminal-only detail). */
  heartbeat_at?: string | null;
};

type GenerationExecution = {
  total: number;
  errored: number;
  error_finish_reasons: Record<string, number>;
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
      return reportCommandError(error, config.backendUrl);
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
      `/v1/agent-task-runs/${resolvedRunId}${verbose ? "?include=transcript" : ""}`,
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
    // Issue #22: project the per-check deliverable bloat (assertion `received`,
    // judge prompt/response, deliverable values) to one-line manifests so
    // `runs show --json` isn't multi-MB. Read full content with
    // `apo runs deliverable <run-id> [name]` — it fetches a deliverable once,
    // not per check.
    const detail = {
      ...runDetail,
      checks_json: conciseChecks(runDetail.checks_json),
      deliverables_json: conciseDeliverables(runDetail.deliverables_json),
    };
    console.log(formatJson(detail));
  } else {
    if (showedLatest) {
      console.log(dim("(latest run)"));
    }
    printRunDetail(runDetail, verbose);
  }

  if (exitStatus) {
    return runDetail.pass_result === true ? 0 : 1;
  }
  return 0;
}

function printRunDetail(run: RunDetail, verbose: boolean): void {
  console.log(bold(`Run: ${run.id}`));
  console.log(`  Task:     ${run.task_id}`);
  console.log(`  Path:     ${run.task_path}`);
  if (run.batch_run_id) {
    console.log(`  Batch:    ${run.batch_run_id} ${dim("(apo batch show " + run.batch_run_id + ")")}`);
  }
  console.log(`  Adapter:  ${run.adapter_name}`);
  // configured model/effort (reported by adapter). The trace's
  // observed model is a separate concern and not shown here.
  if (run.run_configuration) {
    console.log(`  Model:    ${run.run_configuration.model}`);
    console.log(`  Effort:   ${run.run_configuration.effort ?? "-"}`);
  }
  console.log(`  Status:   ${run.status}`);
  const beatLine = formatHeartbeatLine(run);
  if (beatLine) console.log(beatLine);
  console.log(`  Result:   ${run.pass_result === null ? "-" : passFail(run.pass_result)}`);

  if (run.total_checks > 0) {
    const correctedNote =
      run.corrected_tests && run.corrected_tests > 0
        ? yellow(` · ${run.corrected_tests} corrected`)
        : "";
    console.log(
      `  Checks:   ${run.passed_checks}/${run.total_checks} passed (${run.failed_checks} failed)${correctedNote}`,
    );
  }
  if ((run.judgments_count ?? 0) > 0) {
    console.log(
      yellow(`  Judgments: ${run.judgments_count} re-judged ${run.judgments_count === 1 ? "verdict" : "verdicts"} on record `) +
        dim(`(apo runs judgments ${run.id})`),
    );
  }
  if (run.generation_execution && run.generation_execution.errored > 0) {
    console.log(
      `  Generations: ${run.generation_execution.errored}/${run.generation_execution.total} errored${formatFinishReasons(run.generation_execution)}`,
    );
  }

  console.log(`  Started:  ${formatTime(run.started_at)}`);
  if (run.completed_at) {
    console.log(`  Completed: ${formatTime(run.completed_at)}`);
  }
  console.log(`  Source:   ${formatTriggerOpt(run.trigger)}`);
  console.log(`  Cost:     ${formatCost(run.total_cost)}${formatPartialCostSuffix(run)}`);
  if (run.total_tokens != null && run.total_tokens > 0) {
    console.log(
      `  Tokens:   ${run.total_tokens.toLocaleString()}${formatErroredGenerationSuffix(run.generation_execution)}`,
    );
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
    const sjSummary = secondJudgeSummary(run.checks_json);
    if (sjSummary) console.log(dim(`\n  ${sjSummary}`));
  } else if (run.pass_result === false) {
    // Issue #8: a failed run with no checks is a registration bug, not a real
    // failure. The backend also stores this on error_message (see backend
    // finalize_task_run_with_result) — show whichever is available.
    console.log(`\n  ${run.error_message ?? NO_CHECKS_REGISTERED_MESSAGE}`);
  }

  // Deliverables summary — always shown so users discover artifacts exist.
  const manifest = run.deliverables ?? [];
  if (manifest.length > 0) {
    const summary = manifest.map((d) =>
      `${d.name} (${d.kind}${d.size_bytes ? `, ${formatBytes(d.size_bytes)}` : ""})`,
    ).join(", ");
    console.log(`\n  Deliverables: ${summary}`);
    console.log(dim(`    Read one: apo runs deliverable ${run.id} <name>`));
  }

  if (verbose) {
    // Detailed per-item listing.
    if (manifest.length > 0) {
      console.log(bold("\n  Deliverable details:"));
      for (const item of manifest) {
        const filename = item.display_filename ? dim(` (${item.display_filename})`) : "";
        console.log(
          dim(`    ${item.name}: ${item.kind}, ${item.size_bytes} bytes${filename}`),
        );
      }
    } else if (run.deliverables_json) {
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
  }

  if (verbose && run.transcript_json) {
    console.log(bold("\n  Transcript:"));
    printTranscript(run.transcript_json);
  }
}

/**
 * Issue #176: the backend's default attempt lease (APO_ATTEMPT_LEASE_SECONDS).
 * A live run whose beat stream has been silent this long is at risk of being
 * reaped `lost` — say so instead of leaving `batch show --json` as the only
 * window into the heartbeat.
 */
const HEARTBEAT_AT_RISK_MS = 90_000;

const LIVE_RUN_STATUSES = new Set(["pending", "running"]);

function formatHeartbeatLine(run: RunDetail): string | null {
  if (!run.heartbeat_at || !LIVE_RUN_STATUSES.has(run.status)) return null;
  const ageMs = Date.now() - Date.parse(run.heartbeat_at);
  if (!Number.isFinite(ageMs)) return null;
  const line = `  Last beat: ${formatTime(run.heartbeat_at)} (${formatAge(ageMs)} ago)`;
  return ageMs > HEARTBEAT_AT_RISK_MS ? yellow(`${line} — lease at risk`) : line;
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function printTranscript(transcript: Record<string, unknown>): void {  const turns = transcript.turns ?? transcript.messages ?? transcript;
  if (Array.isArray(turns)) {
    for (const turn of turns) {
      if (typeof turn !== "object" || turn === null) continue;
      const t = turn as Record<string, unknown>;
      // SDK TaskTranscriptTurn: { turnNumber, userAction, agentResponse }.
      if ("userAction" in t || "agentResponse" in t) {
        const n = typeof t.turnNumber === "number" ? t.turnNumber : "?";
        console.log(dim(`    --- Turn ${n} ---`));
        const ua = previewTranscriptValue(t.userAction);
        const ar = previewTranscriptValue(t.agentResponse);
        if (ua) console.log(dim(`    [user] ${ua}`));
        if (ar) console.log(dim(`    [agent] ${ar}`));
        continue;
      }
      // Legacy chat-style turns: { role, content }.
      const role = t.role ?? t.actor ?? t.type ?? "?";
      const preview = previewTranscriptValue(t.content ?? t.message ?? t.text);
      console.log(dim(`    [${role}] ${preview}`));
    }
  } else {
    const preview = JSON.stringify(transcript, null, 0).slice(0, 500);
    console.log(dim(`    ${preview}`));
  }
}

function previewTranscriptValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 200);
  return JSON.stringify(value, null, 0).slice(0, 200);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatPartialCostSuffix(run: RunDetail): string {
  const reasons: string[] = [];
  if (run.generation_execution && run.generation_execution.errored > 0) {
    const count = run.generation_execution.errored;
    reasons.push(`${count} errored generation${count === 1 ? "" : "s"}`);
  }
  if (run.unpriced_call_count && run.unpriced_call_count > 0) {
    const count = run.unpriced_call_count;
    reasons.push(`${count} unpriced call${count === 1 ? "" : "s"}`);
  }
  return reasons.length > 0 ? dim(` (partial — ${reasons.join(", ")})`) : "";
}

function formatErroredGenerationSuffix(execution?: GenerationExecution | null): string {
  if (!execution || execution.errored <= 0) return "";
  return dim(
    ` (partial — ${execution.errored} errored generation${execution.errored === 1 ? "" : "s"})`,
  );
}

function formatFinishReasons(execution: GenerationExecution): string {
  const reasons = Object.entries(execution.error_finish_reasons)
    .map(([reason, count]) => `${reason} ×${count}`);
  return reasons.length > 0 ? dim(` (${reasons.join(", ")})`) : "";
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
