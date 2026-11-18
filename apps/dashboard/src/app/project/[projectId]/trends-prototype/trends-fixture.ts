// PROTOTYPE · deterministic demo dataset for the run-trends prototype
// (?data=demo). 60 suite-scale batch runs over ~40 days telling one fixed
// harness-engineering story, generated from a single seeded LCG (no
// Math.random) so every reload renders identical numbers. Row shapes match
// what the real fetch path feeds buildTrendData/buildTaskMatrix. The arc and
// the measured prod parameters it honors are documented in NOTES.md.

import type { AgentTaskRunSummary } from "@/lib/agent-task-api";
import type { TrendPoint } from "./trends-data";

const SEED = 6446; // chosen so the arc's visible beats land (dip at 25, converge at 60)
const RUN_COUNT = 60;
const WINDOW_DAYS = 40;
const FIRST_DAY_UTC = Date.UTC(2026, 9, 10); // 40 days ending 2026-11-18, pinned so the story never drifts
const BURST_DAY = 21;
const ERRORED_BATCH = 31; // executor timeout: zero checks in the whole batch
const DEBUG_RUNS = new Set([44, 46]); // single-task CLI debug runs of t-jev-split
const DOCX_REGRESSION = new Set([25, 26, 27, 28, 29]); // glm switch breaks the docx schema checks
const LATE_REGRESSION = new Set([53, 54]); // harness change regresses two tasks

interface ModelPhase {
  from: number;
  to: number;
  model: string;
  /** Per task run, dollars. */
  cost: [number, number];
  /** Per task run. */
  tokens: [number, number];
}

const PHASES: ModelPhase[] = [
  {
    from: 1,
    to: 24,
    model: "deepseek/deepseek-v4.1-flash",
    cost: [0.02, 0.05],
    tokens: [35000, 75000],
  },
  {
    from: 25,
    to: 38,
    model: "z-ai/glm-5.3-flash",
    cost: [0.03, 0.06],
    tokens: [30000, 65000],
  },
  {
    from: 39,
    to: 60,
    model: "google/gemini-2.5-flash-lite",
    cost: [0.01, 0.02],
    tokens: [8000, 20000],
  },
];

interface DemoTask {
  index: number;
  id: string;
  path: string;
  /** Fixed per task, 1-8 weighted toward the 2-6 modal band. */
  checks: number;
  /** 0 easy .. 1 hard; spreads pass probability around the phase target. */
  difficulty: number;
  veteran?: boolean;
  flaky?: boolean;
  errorProne?: boolean;
  docxRegression?: boolean;
  lateRegression?: boolean;
  addedAtRun?: number;
}

const TASK_PATHS: Omit<DemoTask, "index" | "id" | "checks" | "difficulty">[] = [
  { path: "data-extraction-replay", veteran: true },
  { path: "data-extraction" },
  { path: "t-jev-split", flaky: true },
  { path: "tasks/judge-quality/jq-history-recurring" },
  { path: "steering-correction" },
  { path: "t-agent-demo" },
  { path: "t-describe-groups" },
  { path: "t-jekyll-split" },
  { path: "tasks/docx/docx-insert-at-cursor", docxRegression: true },
  { path: "tasks/docx/docx-table-cell-merge", docxRegression: true },
  { path: "tasks/docx/docx-rejected-edit", docxRegression: true },
  { path: "tasks/docx/docx-style-preservation" },
  { path: "tasks/pdf/pdf-extract-tables" },
  { path: "tasks/xlsx/xlsx-pivot-verify" },
  { path: "web-research-summaries", lateRegression: true },
  { path: "multi-step-form-filling", lateRegression: true },
  { path: "t-fact-check", addedAtRun: 20 },
  { path: "t-summarize-thread", errorProne: true },
];

/** Same output on every call: one fresh LCG per invocation, consumed in a
 * fixed order by straight-line loops. */
export function buildDemoData(): {
  points: TrendPoint[];
  taskRuns: AgentTaskRunSummary[];
} {
  const rand = makeLcg(SEED);
  const tasks: DemoTask[] = TASK_PATHS.map((task, i) => ({
    ...task,
    index: i + 1,
    id: `demo_task_${pad2(i + 1)}`,
    checks: drawCheckCount(rand),
    difficulty: rand(),
  }));
  const timestamps = buildTimestamps(buildDayCounts(rand), rand);
  const points: TrendPoint[] = [];
  const taskRuns: AgentTaskRunSummary[] = [];

  for (let runNo = 1; runNo <= RUN_COUNT; runNo++) {
    const phase = phaseFor(runNo);
    const batchRunId = `demo_bch_${pad2(runNo)}`;
    const createdAt = timestamps[runNo - 1];
    const suite = tasks.filter((task) => {
      if (task.addedAtRun !== undefined && runNo < task.addedAtRun) return false;
      return DEBUG_RUNS.has(runNo) ? task.flaky === true : true;
    });
    const freeP = freePassProb(runNo, rand);
    let passedTasks = 0;
    let erroredTasks = 0;
    let passedChecks = 0;
    let totalChecks = 0;
    let totalCost = 0;
    let totalTokens = 0;

    for (const task of suite) {
      const status = drawStatus(task, runNo, freeP, rand);
      const checks = status === "error" ? 0 : task.checks;
      const passedChk =
        status === "passed"
          ? checks
          : status === "failed"
            ? checks - drawFailingChecks(checks, rand)
            : 0;
      const cost =
        status === "error" || rand() < 0.1
          ? null
          : round4(drawInRange(phase.cost, rand));
      const tokens =
        status === "error"
          ? null
          : Math.round(drawInRange(phase.tokens, rand) / 50) * 50;

      taskRuns.push({
        id: `demo_run_${pad2(runNo)}_${pad2(task.index)}`,
        batch_run_id: batchRunId,
        task_id: task.id,
        task_path: task.path,
        adapter_name: null,
        status,
        pass_result: status === "passed" ? true : status === "failed" ? false : null,
        started_at: createdAt,
        completed_at: createdAt,
        trace_run_id: null,
        primary_model: phase.model,
        task_source_commit_sha: null,
        error_message:
          status === "error" ? errorMessage(runNo, task.errorProne === true) : null,
        total_cost: cost,
        total_tokens: tokens,
        total_checks: checks,
        passed_checks: passedChk,
        failed_checks: checks - passedChk,
        no_verdict_reason:
          status === "error" ? (runNo === ERRORED_BATCH ? "executor" : "generations") : null,
        trigger: null,
        trace_persistence_status: "persisted",
        trace_error_message: null,
        error_category:
          status === "error"
            ? runNo === ERRORED_BATCH
              ? "executor_timeout"
              : "generation_error"
            : null,
        run_configuration: { model: phase.model, effort: null },
        environment: null,
        labels: {},
      });

      if (status === "passed") passedTasks++;
      if (status === "error") erroredTasks++;
      passedChecks += passedChk;
      totalChecks += checks;
      if (cost !== null) totalCost += cost;
      if (tokens !== null) totalTokens += tokens;
    }

    points.push({
      batchRunId,
      createdAt,
      passedTasks,
      totalTasks: suite.length,
      passedChecks,
      totalChecks,
      erroredTasks,
      totalCost: round4(totalCost),
      totalTokens,
      models: [phase.model],
    });
  }

  return { points, taskRuns };
}

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function drawInRange(range: [number, number], rand: () => number): number {
  return range[0] + rand() * (range[1] - range[0]);
}

function phaseFor(runNo: number): ModelPhase {
  for (const phase of PHASES) {
    if (runNo >= phase.from && runNo <= phase.to) return phase;
  }
  return PHASES[PHASES.length - 1];
}

function drawCheckCount(rand: () => number): number {
  const draw = rand();
  if (draw < 0.18) return 1;
  if (draw < 0.7) return 2 + Math.floor(rand() * 3);
  if (draw < 0.92) return 5 + Math.floor(rand() * 2);
  return 7 + Math.floor(rand() * 2);
}

/** Failed runs typically break one or two checks, not all of them. */
function drawFailingChecks(total: number, rand: () => number): number {
  return Math.min(total, 1 + (rand() < 0.4 ? 1 : 0));
}

/** Forced beats first (error batch, docx schema regression, late harness
 * regression), standing traits next, everything else draws against the
 * phase's free probability adjusted by task difficulty. */
function drawStatus(
  task: DemoTask,
  runNo: number,
  freeP: number,
  rand: () => number,
): "passed" | "failed" | "error" {
  if (runNo === ERRORED_BATCH) return "error";
  if (task.errorProne && rand() < 1 / 6) return "error";
  if (task.docxRegression && DOCX_REGRESSION.has(runNo)) return "failed";
  if (task.lateRegression && LATE_REGRESSION.has(runNo)) return "failed";
  if (task.veteran) return "passed";
  if (task.flaky) return rand() < 0.5 ? "passed" : "failed";
  const p = clamp01(freeP + (0.5 - task.difficulty) * 0.22);
  return rand() < p ? "passed" : "failed";
}

function clamp01(value: number): number {
  return Math.min(0.99, Math.max(0.02, value));
}

/** Pass probability for the tasks that draw freely in this run; the ramps
 * carry the arc, forced regressions stack on top. */
function freePassProb(runNo: number, rand: () => number): number {
  const wobble = (amp: number) => (rand() - 0.5) * amp;
  if (runNo <= 12) return 0.58 + wobble(0.05);
  if (runNo <= 19) return 0.7 + (0.08 * (runNo - 13)) / 6 + wobble(0.03);
  if (runNo <= 24) return 0.78 + (0.03 * (runNo - 20)) / 4 + wobble(0.03);
  if (runNo <= 29) return 0.73 + wobble(0.02);
  if (runNo <= 38) return 0.74 + (0.12 * (runNo - 30)) / 8 + wobble(0.03);
  if (runNo <= 43) return 0.85 + (0.03 * (runNo - 39)) / 4 + wobble(0.02);
  if (runNo <= 52) return 0.86 + (0.04 * (runNo - 44)) / 8 + wobble(0.02);
  if (runNo <= 54) return 0.83 + wobble(0.02);
  if (runNo <= 56) return 0.85 + wobble(0.02);
  if (runNo <= 58) return 0.93 + (0.03 * (runNo - 57)) / 1;
  if (runNo <= 59) return 0.97;
  return 0.995;
}

function errorMessage(runNo: number, errorProne: boolean): string {
  return runNo === ERRORED_BATCH
    ? "executor timeout: task did not complete within 600s"
    : errorProne
      ? "generation transport error after 3 retries"
      : "executor timeout: task did not complete within 600s";
}

/** 1-3 runs per day plus one burst day of 5, trimmed or topped up until the
 * window holds exactly RUN_COUNT runs. */
function buildDayCounts(rand: () => number): number[] {
  const counts = Array.from({ length: WINDOW_DAYS }, () => 0);
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const draw = rand();
    counts[i] = draw < 0.55 ? 1 : draw < 0.85 ? 2 : 3;
  }
  counts[BURST_DAY] = 5;
  let sum = counts.reduce((a, b) => a + b, 0);
  for (let guard = 0; guard < 10000 && sum !== RUN_COUNT; guard++) {
    const i = Math.floor(rand() * WINDOW_DAYS);
    if (i === BURST_DAY) continue;
    if (sum < RUN_COUNT && counts[i] < 3) {
      counts[i]++;
      sum++;
    } else if (sum > RUN_COUNT && counts[i] > 1) {
      counts[i]--;
      sum--;
    }
  }
  return counts;
}

function buildTimestamps(dayCounts: number[], rand: () => number): string[] {
  const stamps: string[] = [];
  for (let day = 0; day < dayCounts.length; day++) {
    const burst = dayCounts[day] >= 5;
    let hour = 7 + Math.floor(rand() * (burst ? 7 : 10));
    for (let j = 0; j < dayCounts[day]; j++) {
      const iso = `${dayIso(day)}T${pad2(hour)}:${pad2(Math.floor(rand() * 60))}:${pad2(Math.floor(rand() * 60))}Z`;
      stamps.push(iso);
      hour += 1 + Math.floor(rand() * 2);
    }
  }
  return stamps;
}

function dayIso(dayIndex: number): string {
  return new Date(FIRST_DAY_UTC + dayIndex * 86400000).toISOString().slice(0, 10);
}
