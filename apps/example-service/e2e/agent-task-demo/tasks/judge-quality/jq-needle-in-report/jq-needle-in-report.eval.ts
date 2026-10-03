import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — needle-in-report case (efficiency + accuracy).
 * A large report (~130 KB) whose opening summary claims October mean
 * latency 231 ms / p95 412 ms; the only supporting data is the raw-sample
 * appendix at the very end. The verdict must come from locating and
 * matching the appendix, and the session telemetry (read bytes, tool
 * calls, steps) shows whether the judge searched instead of paginating
 * the whole document. Ground truth: PASS.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-needle-in-report
 */

function fillerSection(index: number): string {
  const topics = [
    "onboarding funnel notes",
    "support desk highlights",
    "sales pipeline color",
    "infrastructure spend review",
    "hiring update",
    "partner integrations",
    "security posture notes",
    "mobile app telemetry",
    "billing pipeline notes",
    "data warehouse housekeeping",
  ];
  const latency = 190 + ((index * 37) % 80); // plausible decoys: 190-269 ms
  return (
    `## Section ${index}: ${topics[index % topics.length]}\n\n` +
    `Routine coverage. Internal probes this month averaged ${latency} ms for interactive ` +
    `requests, in line with last month. No incidents to report, no SLA changes, and the ` +
    `capacity plan is unchanged. The dashboard screenshots are attached to the wiki ` +
    `page rather than inlined here. Follow-ups are tracked in the usual board.\n`
  );
}

const REPORT =
  `# October Service Report\n\n` +
  `## Executive summary\n\n` +
  `October mean service latency was 231 ms with a p95 of 412 ms, per the raw samples ` +
  `in Appendix D of this report.\n\n` +
  Array.from({ length: 40 }, (_, i) => fillerSection(i + 1)).join("\n") +
  `\n## Appendix D: Raw latency samples (October)\n\n` +
  `{"source":"edge_probe","window":"2026-10-01/2026-10-31","samples":41877,"mean_ms":231,"p95_ms":412,"p99_ms":688}\n`;

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { report: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the October report" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ report: REPORT }),
});

const { test } = task("jq-needle-in-report", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: verify the summary's latency claims against the report's own Appendix D. Ground truth: judge PASSES it.",
  metadata: { category: "judge-quality", ground_truth: "pass" },
  deliverables: ["report"],
});

test("headline-matches-appendix", async (t) => {
  await t.agent(
    "PASS only if the headline claims in the report's opening summary (October mean " +
      "service latency 231 ms and p95 412 ms) match the report's own Appendix D raw " +
      "sample data. FAIL if either number disagrees with the appendix or the appendix " +
      "is missing. Investigate the report deliverable before deciding.",
    { label: "agentic-support" },
  );
});
