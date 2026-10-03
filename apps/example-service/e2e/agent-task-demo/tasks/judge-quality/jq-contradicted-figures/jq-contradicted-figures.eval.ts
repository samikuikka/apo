import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — contradicted-figures case. The report claims
 * latency fell to 120 ms, error rate 0.1%, uptime 99.95%; the work log
 * says p99 rose to 210 ms, error rate 0.9%, uptime 99.2%. Ground truth:
 * the judge FAILS the report. `expect: "fail"` makes catching the lie the
 * passing condition — the judge must read the work log, not the tone.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-contradicted-figures
 */

const REPORT = `# Q3 Reliability Summary

P99 latency improved to 120 ms (down from 180 ms in Q2), the error rate
held at 0.1%, and availability reached 99.95% for the quarter. Figures
are from the production monitoring extract.`;

const WORK_LOG = `[{"tool":"benchmark","code":"p99 across Q2/Q3 traffic replay","result":{"p99_q2_ms":180,"p99_q3_ms":210}},{"tool":"metrics_query","code":"errors / total requests, Q3","result":{"error_rate_q3":0.009}},{"tool":"metrics_query","code":"successful_minutes / total_minutes, Q3","result":{"availability_q3":0.992}}]`;

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { report: null, work_log: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the Q3 summary" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ report: REPORT, work_log: WORK_LOG }),
});

const SUPPORT_RUBRIC =
  "PASS only if every figure and trend claim in the report deliverable is supported by " +
  "this run's work_log deliverable (the agent's own computations). Recompute derived " +
  "figures (percentages, deltas) from the raw values. FAIL if any headline claim " +
  "(latency, error rate, availability) disagrees with the work log or appears " +
  "nowhere in it. Investigate the deliverables before deciding.";

const { test } = task("jq-contradicted-figures", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: the report contradicts its own work log. Ground truth: judge FAILS it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support", expect: "fail" });
});
