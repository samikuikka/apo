// PROTOTYPE · deterministic demo dataset for the suite-health prototype
// (?data=demo). 60 suite-scale runs over 40 days ending 2026-11-18 across the
// same three model phases as the trends fixture, with each task playing one
// health role. No randomness: outcomes come from fixed patterns on the run
// number, so every reload classifies identically. Roles are documented in
// NOTES.md.

import { classifyTaskHealth, type HealthOutcome, type HealthRun, type TaskHealth } from "./health-data";

const RUN_COUNT = 60;
const FIRST_RUN_AT = Date.UTC(2026, 10, 18) - (RUN_COUNT - 1) * 16 * 3600_000;

/** Model phases: which provider each run number executed under. */
const PHASES = [
  { from: 1, to: 24, model: "deepseek/deepseek-v4.1-flash", cost: 0.04 },
  { from: 25, to: 38, model: "z-ai/glm-5.3-flash", cost: 0.05 },
  { from: 39, to: 60, model: "google/gemini-2.5-flash-lite", cost: 0.015 },
] as const;

function phaseFor(runNo: number) {
  return PHASES.find((p) => runNo >= p.from && runNo <= p.to) ?? PHASES[PHASES.length - 1];
}

type Pattern = (runNo: number) => HealthOutcome;

const pass: Pattern = () => "passed";
const fail: Pattern = () => "failed";
/** Deterministic stand-in for a coin: cycle of 10, pass `tenths` of them. */
const coin = (tenths: number): Pattern => (runNo) =>
  (runNo * 7) % 10 < tenths ? "passed" : "failed";
/** Fails every n-th run: a light, visible failure history. */
const everyNth = (n: number): Pattern => (runNo) =>
  runNo % n === 0 ? "failed" : "passed";
/** Fails inside [from, to] only (regression window). */
const between = (from: number, to: number): Pattern => (runNo) =>
  runNo >= from && runNo <= to ? "failed" : "passed";
/** Fails from a run onward, never recovering. */
const since = (from: number): Pattern => (runNo) => (runNo >= from ? "failed" : "passed");
/** Errors every n-th run (infrastructure, not a verdict). */
const errorsEvery = (n: number): Pattern => (runNo) =>
  runNo % n === 0 ? "error" : "passed";

interface FixtureTask {
  path: string;
  /** First run the task exists in (default 1). */
  addedAtRun?: number;
  /** Outcome pattern per phase model; tasks missing a phase never ran it. */
  patterns: Partial<Record<(typeof PHASES)[number]["model"], Pattern>>;
}

const TASKS: FixtureTask[] = [
  // Saturated: passed every run under all three models. Prune or harden.
  { path: "data-extraction-replay", patterns: { "deepseek/deepseek-v4.1-flash": pass, "z-ai/glm-5.3-flash": pass, "google/gemini-2.5-flash-lite": pass } },
  { path: "t-agent-demo", patterns: { "deepseek/deepseek-v4.1-flash": pass, "z-ai/glm-5.3-flash": pass, "google/gemini-2.5-flash-lite": pass } },
  { path: "t-describe-groups", patterns: { "deepseek/deepseek-v4.1-flash": pass, "z-ai/glm-5.3-flash": pass, "google/gemini-2.5-flash-lite": pass } },
  // Stuck: a late regression that was never fixed; every model fails it now.
  { path: "web-research-summaries", patterns: { "deepseek/deepseek-v4.1-flash": since(30), "z-ai/glm-5.3-flash": fail, "google/gemini-2.5-flash-lite": fail } },
  // Erroring: infrastructure noise, roughly 1 errored run in 5.
  { path: "t-summarize-thread", patterns: { "deepseek/deepseek-v4.1-flash": errorsEvery(5), "z-ai/glm-5.3-flash": errorsEvery(5), "google/gemini-2.5-flash-lite": errorsEvery(5) } },
  // Quiet, one model only: added with the gemini switch, always passes.
  { path: "t-jekyll-split", addedAtRun: 39, patterns: { "google/gemini-2.5-flash-lite": pass } },
  // Sparse: added days ago, not enough graded runs to judge.
  { path: "steering-correction", addedAtRun: 57, patterns: { "google/gemini-2.5-flash-lite": pass } },
  // Healthy separators: the docx regression under glm, fact-check under glm.
  { path: "tasks/docx/docx-insert-at-cursor", patterns: { "deepseek/deepseek-v4.1-flash": pass, "z-ai/glm-5.3-flash": between(25, 29), "google/gemini-2.5-flash-lite": pass } },
  { path: "tasks/docx/docx-table-cell-merge", patterns: { "deepseek/deepseek-v4.1-flash": pass, "z-ai/glm-5.3-flash": between(25, 29), "google/gemini-2.5-flash-lite": pass } },
  { path: "tasks/docx/docx-rejected-edit", patterns: { "deepseek/deepseek-v4.1-flash": pass, "z-ai/glm-5.3-flash": between(25, 29), "google/gemini-2.5-flash-lite": pass } },
  { path: "tasks/pdf/pdf-extract-tables", patterns: { "deepseek/deepseek-v4.1-flash": coin(9), "z-ai/glm-5.3-flash": coin(4), "google/gemini-2.5-flash-lite": coin(8) } },
  { path: "tasks/xlsx/xlsx-pivot-verify", patterns: { "deepseek/deepseek-v4.1-flash": coin(7), "z-ai/glm-5.3-flash": coin(1), "google/gemini-2.5-flash-lite": coin(7) } },
  { path: "t-fact-check", addedAtRun: 20, patterns: { "deepseek/deepseek-v4.1-flash": coin(9), "z-ai/glm-5.3-flash": coin(2), "google/gemini-2.5-flash-lite": coin(9) } },
  // Steady: mixed outcomes, similar across models.
  { path: "data-extraction", patterns: { "deepseek/deepseek-v4.1-flash": everyNth(12), "z-ai/glm-5.3-flash": pass, "google/gemini-2.5-flash-lite": pass } },
  { path: "tasks/docx/docx-style-preservation", patterns: { "deepseek/deepseek-v4.1-flash": between(5, 5), "z-ai/glm-5.3-flash": pass, "google/gemini-2.5-flash-lite": pass } },
  { path: "tasks/judge-quality/jq-history-recurring", patterns: { "deepseek/deepseek-v4.1-flash": coin(9), "z-ai/glm-5.3-flash": coin(9), "google/gemini-2.5-flash-lite": coin(9) } },
  { path: "multi-step-form-filling", patterns: { "deepseek/deepseek-v4.1-flash": coin(6), "z-ai/glm-5.3-flash": coin(6), "google/gemini-2.5-flash-lite": coin(6) } },
  { path: "t-jev-split", patterns: { "deepseek/deepseek-v4.1-flash": coin(5), "z-ai/glm-5.3-flash": coin(5), "google/gemini-2.5-flash-lite": coin(5) } },
];

/** Deterministic health roles over the 18 real task paths. */
export function buildDemoHealth(): TaskHealth[] {
  const byTask = new Map<string, HealthRun[]>();
  TASKS.forEach((task, index) => {
    const taskId = `demo_task_${String(index + 1).padStart(2, "0")}`;
    const runs: HealthRun[] = [];
    for (let runNo = 1; runNo <= RUN_COUNT; runNo += 1) {
      const firstRun = task.addedAtRun ?? 1;
      if (runNo < firstRun) continue;
      const phase = phaseFor(runNo);
      const pattern = task.patterns[phase.model];
      if (!pattern) continue;
      runs.push({
        taskRunId: `demo_tr_${runNo}_${index}`,
        taskId,
        taskPath: task.path,
        outcome: pattern(runNo),
        model: phase.model,
        // Small per-task variation so cost columns are not identical rows.
        cost: phase.cost * (1 + (index % 3) * 0.2),
        at: new Date(FIRST_RUN_AT + (runNo - 1) * 16 * 3600_000).toISOString(),
      });
    }
    byTask.set(taskId, runs);
  });
  const tasks = [...byTask.entries()].map(([taskId, runs]) =>
    classifyTaskHealth(taskId, TASKS.find((t) => runs[0]?.taskPath === t.path)?.path ?? runs[0]?.taskPath ?? taskId, runs),
  );
  return tasks.sort(
    (a, b) =>
      rankOf(a.state) - rankOf(b.state) || a.taskPath.localeCompare(b.taskPath),
  );
}

// Local rank copy so the fixture does not depend on the real-data ordering
// helper staying exported; same order as the review page's sections.
const RANKS: Record<TaskHealth["state"], number> = {
  saturated: 0,
  stuck: 1,
  erroring: 2,
  quiet: 3,
  steady: 4,
  healthy: 5,
  sparse: 6,
};

function rankOf(state: TaskHealth["state"]): number {
  return RANKS[state];
}
