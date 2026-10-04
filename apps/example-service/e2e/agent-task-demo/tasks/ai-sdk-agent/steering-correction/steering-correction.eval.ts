/**
 * steering-correction — mid-run steering as a spec-level capability.
 *
 * The task asks for a revenue report, then corrects the rule while the agent
 * is mid-run: a steer scheduled at the 2nd tool boundary tells it to exclude
 * cancelled orders. This is the interaction every coding-agent user has daily
 * ("wait, use the other rule") — and the thing no eval framework expresses:
 * the spec scripts WHEN the correction lands and asserts WHAT the harness did
 * about it.
 *
 * Ground truth is arithmetic: completed orders sum to 9,200.00, cancelled to
 * 2,280.00, everything to 11,480.00. A harness that drops the steer reports
 * 11,480.00; one that acknowledges it but ignores it also reports 11,480.00.
 *
 * Layers: steer delivery (deterministic) → post-steer window (deterministic)
 * → corrected total (deterministic) → coherence (judge).
 */
import { task, turn, steer, satisfies } from "@apo-ai/sdk/agent-task";
import { aiSdkAdapter } from "../../../ai-sdk-adapter.ts";

const { test: check } = task("steering-correction", {
  adapter: aiSdkAdapter,
  description: "Build a revenue report, then correct the rule mid-run (steering demo).",
  metadata: { category: "steering", difficulty: "medium", sdk: "ai-sdk" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

turn(async (ctx) => {
  if (ctx.transcript.length > 0) return null;
  return (
    "Build the monthly revenue report from data/orders.csv. " +
    "Include every order in the totals, all statuses. " +
    "End the report with a line of the exact form: Total revenue: X,XXX.XX " +
    "(thousands separators, two decimals)."
  );
});

// The scripted correction: lands at the 2nd tool boundary of turn 1 — after
// the agent has listed and read the file, while it is still working.
steer({
  when: { toolResults: 2 },
  label: "exclude-cancelled",
  message:
    "Correction: exclude cancelled orders from all revenue totals. " +
    "Keep the same report format with the corrected Total revenue line.",
});

// ── Layer 1: the correction was delivered and consumed ───────────────────
// Deterministic: a task.steer event exists, a generation ran after it. Fails
// when the harness dropped the message or no model call ever saw it.
check("correction-was-delivered", (t) => {
  t.steerDelivered(1);
});

// ── Layer 2: what the agent did after the steer ──────────────────────────
// The post-steer window: enough activity to have reacted, not so much that
// it thrashed. (Pair with steerDelivered — a ceiling alone could pass
// vacuously against an empty window.)
check("reacted-without-thrashing", (t) => {
  t.afterSteer(1, (t2) => {
    t2.maxToolCalls(12);
  });
});

// ── Layer 3: the deliverable incorporates the correction ─────────────────
// The deterministic anchor: the final "Total revenue" line must be 9,200.00
// — only reachable by excluding the cancelled rows. The report MAY mention
// 11,480.00 in prose (a good agent flags the instruction conflict); the
// TOTAL is what the steer must have corrected.
check("report-incorporates-correction", (t, { deliverables }) => {
  const report = String((deliverables.result as { summary: string }).summary);
  const totalLine = /Total revenue:\s*([\d,.]+)/.exec(report);
  const total = totalLine?.[1] ?? "(no Total revenue line)";
  t.check(
    total,
    satisfies((s: string) => /9[,.]?200\.00/.test(s), "be the corrected 9,200.00"),
    "Total revenue line is corrected",
  );
});

// ── Layer 4: judged coherence ────────────────────────────────────────────
// The numbers above could in principle survive a mangled report; the judge
// confirms the report reads as if the exclusion rule was always in force.
check("correction-is-coherent", async (t, { deliverables }) => {
  const report = String((deliverables.result as { summary: string }).summary);
  await t.judge(
    report,
    "PASS only if this monthly revenue report consistently excludes cancelled orders: every total and the final 'Total revenue' line count completed orders only (9,200.00), cancelled orders (2,280.00) are either excluded or explicitly broken out as non-revenue, and the report reads as a coherent whole rather than a correction pasted on top. FAIL if any revenue total still includes cancelled amounts, or if the report acknowledges the instruction without applying it.",
  );
});
