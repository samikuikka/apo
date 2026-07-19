/**
 * bug-triage — demonstrates `t.messageIncludes` and severity-reasoning judges.
 *
 * Bug triage is fundamentally about reasoning, not fact recall: given an error
 * log, the agent must distinguish error types, assign severity, and identify
 * root cause. The deterministic layer here is thinner (the log contains
 * objective signals — stack traces, order IDs, file paths), but the real
 * assessment is in the judges: did the agent reason correctly about severity
 * and root cause?
 *
 * This task also demonstrates `t.messageIncludes` — asserting the agent's
 * final reply contains specific tokens (order IDs, error types), which is
 * useful when the answer lives in the response text rather than the
 * structured findings.
 *
 * Layers: trajectory → fact table (error signals + messageIncludes) →
 * judges (completeness, severity reasoning, fix-area specificity).
 */
import {
  task,
  test,
  includes,
  satisfies,
  filePaths,
} from "@apo/sdk/agent-task";
import { realAgentAdapter } from "../../../../real-agent-adapter.ts";
import type { RealAgentDeliverables } from "../../../../real-agent-adapter.ts";
import {
  MAX_TURNS,
  MAX_DURATION_MS,
  MAX_TOOL_CALLS,
  DESTRUCTIVE_TOOLS,
  assertFacts,
  joinFindings,
} from "../../checks-helpers.ts";

task("bug-triage", {
  adapter: realAgentAdapter,
  description:
    "Triage a bug report by analyzing error logs, searching for related stack traces, and determining severity.",
  metadata: { category: "debugging", difficulty: "medium" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// Objective signals from error.log. These are deterministic anchors — the
// log contains two distinct error types at specific locations affecting
// specific orders. The agent must identify all of them.
const EXPECTED_SIGNALS = [
  { label: "TaxService error", pattern: /TaxService|tax\.js/ },
  { label: "TypeError", pattern: /TypeError/ },
  { label: "tax.js line", pattern: /tax\.js:45/ },
  { label: "DiscountService error", pattern: /DiscountService|discount\.js/ },
  { label: "RangeError", pattern: /RangeError/ },
  { label: "discount.js line", pattern: /discount\.js:28/ },
  { label: "order ORD-4521", pattern: /ORD-4521/ },
  { label: "order ORD-4523", pattern: /ORD-4523/ },
  { label: "order ORD-4525", pattern: /ORD-4525/ },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
check("analyzed-error-log", (t) => {
  t.calledTool("read_file", { input: { path: /error\.log/ } });
  t.calledTool("search_content");
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective signals ───────────────────────────────────────────
// The agent must identify BOTH error types and ALL three affected orders.
// This is the anti-conflation anchor — a shallow triage that says "there's
// a TypeError in the order service" without distinguishing the two distinct
// errors (TypeError in tax.js vs RangeError in discount.js) fails here.
check("identified-both-error-types", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, EXPECTED_SIGNALS);

  // The agent's reply must also mention both error types — `messageIncludes`
  // checks the final response text, not just the structured findings.
  t.messageIncludes(/tax\.js|TaxService/);
  t.messageIncludes(/discount\.js|DiscountService/);

  t.check(
    deliverables.stats.total_tool_calls,
    satisfies((n: number) => n >= 2, "used at least 2 tools"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: completeness. Did the agent distinguish the two error types as
// SEPARATE issues, or conflate them into one? A good triage says "issue 1:
// TypeError in tax.js (ORD-4521, ORD-4523)" and "issue 2: RangeError in
// discount.js (ORD-4525)" — not "there are errors in the order service."
check("distinguished-error-types", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the findings clearly distinguish TWO separate error types: (1) a TypeError in TaxService (tax.js:45) affecting orders ORD-4521 and ORD-4523, caused by an undefined tax_rate, AND (2) a RangeError in DiscountService (discount.js:28) affecting ORD-4525, caused by infinite recursion in discount stacking. FAIL if the two errors are conflated into one issue, or if either error type is missing.",
  );
});

// Judge B: severity reasoning. Did the agent assign sensible severity levels
// with justification? The TypeError affects 15% of orders (production
// blocker); the RangeError is triggered by a specific coupon (narrower
// blast radius but still a crash). A good triage explains WHY each severity
// was assigned.
check("assigned-reasonable-severity", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the triage assigns severity levels (e.g. critical/high for the TypeError affecting 15% of production orders, high/medium for the RangeError triggered by a specific coupon) WITH reasoning that justifies the level based on blast radius, urgency, and production impact. FAIL if severity is missing, assigned without justification, or all issues get the same level without differentiation.",
  );
});

// Judge C: fix-area specificity. Did the agent point at a concrete fix area,
// or just say "fix the bug"? A good triage says "add a null check for
// tax_rate before calling toFixed in tax.js:45" and "add recursion depth
// limiting or cycle detection in discount.js:28."
check("pointed-at-fix-area", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the findings suggest concrete fix areas for each error: e.g. 'add null/undefined check for tax_rate before toFixed in tax.js' and 'add recursion guard or cycle detection in discount.js discount stacking logic'. FAIL if fix suggestions are generic like 'fix the error' or 'check the logs' without pointing at a specific code area.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("error-log-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("error.log"));
});
