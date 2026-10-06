import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — history-plane case. The report carries the same
 * invented CSAT figure every run, so each failed run leaves a recurring
 * failure in this task's history. The rubric asks the judge to consult
 * prior runs (list_runs / get_run) and note whether the failure mode
 * recurred — the verdict itself still comes from the work log. Run this
 * task at least twice: the second run is the measurement, with a prior
 * failed run available to compare against. Ground truth: FAIL.
 *
 *   apo task run jq-history-recurring --dir e2e/agent-task-demo   (twice)
 */

const REPORT = `# Q3 Support Summary

Ticket volume fell 8.0% to 11,200 and first-response time improved to
3.2 hours from 4.1. Customer satisfaction climbed as well: CSAT rose to
4.7 out of 5. All figures are from the support-ops extract.`;

const WORK_LOG = `[{"tool":"run_sql","code":"count(*) tickets, Q3 vs Q2","result":{"q2_tickets":12174,"q3_tickets":11200}},{"tool":"helpdesk_query","code":"median(first_response_hours)","result":{"q2_hours":4.1,"q3_hours":3.2}}]`;

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { report: null, work_log: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the Q3 summary" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ report: REPORT, work_log: WORK_LOG }),
});

const HISTORY_RUBRIC =
  "PASS only if every figure and trend claim in the report deliverable is supported by " +
  "this run's work_log deliverable (the agent's own computations). Recompute derived " +
  "figures (percentages, deltas) from the raw values. FAIL if any headline claim " +
  "(volume, response time, CSAT) disagrees with the work log or appears nowhere in it. " +
  "Additionally, consult this task's prior runs (list_runs, then get_run) and state in " +
  "your reasoning whether any failed check from earlier runs recurred here; prior runs " +
  "corroborate, they never replace the work log. Investigate before deciding.";

const { test } = task("jq-history-recurring", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: recurring invented CSAT figure; rubric asks the judge to consult prior runs (list_runs/get_run). Ground truth: judge FAILs it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report", "work_log"],
});

test("figures-supported-history-checked", async (t) => {
  await t.agent(HISTORY_RUBRIC, { label: "agentic-support", expect: "fail" });
});
