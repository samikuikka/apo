/**
 * steering-correction (pi) — the real-harness steering proof.
 *
 * Identical ground truth to the ai-sdk steering demo, but the agent under
 * test is the pi coding agent with its NATIVE session.steer(): apo scripts
 * WHEN the correction lands and asserts WHAT pi did about it. This is the
 * interaction respan can only observe; here it is a specification.
 *
 * Arithmetic anchor: completed orders sum to 9,200.00, cancelled to
 * 2,280.00, everything to 11,480.00. A harness that drops the steer or
 * acknowledges-but-ignores it reports the uncorrected total.
 *
 * Layers: steer delivery (deterministic) → post-steer window (deterministic)
 * → corrected Total revenue line (deterministic) → coherence (judge).
 */
import {
  task,
  turn,
  steer,
  satisfies,
} from "@apo-ai/sdk/agent-task";
import { piAdapter } from "../../../pi-adapter.ts";

const { test: check } = task("steering-correction-pi", {
  adapter: piAdapter,
  description: "Build a revenue report with pi, then correct the rule mid-run (native steer).",
  metadata: { category: "steering", difficulty: "medium", sdk: "pi" },
  maxTurns: 2,
  deliverables: ["result"],
});

turn(async (ctx) => {
  if (ctx.transcript.length > 0) return null;
  return (
    "Build the monthly revenue report from files/data/orders.csv. " +
    "Include every order in the totals, all statuses. " +
    "End the report with a line of the exact form: Total revenue: X,XXX.XX " +
    "(thousands separators, two decimals)."
  );
});

// The scripted correction: lands at the 2nd tool boundary of turn 1. pi's
// steer() queues it "after the current assistant turn finishes executing its
// tool calls, before the next LLM call" — the same boundary apo schedules on.
steer({
  when: { toolResults: 2 },
  label: "exclude-cancelled",
  message:
    "Correction: exclude cancelled orders from all revenue totals. " +
    "Keep the same report format with the corrected Total revenue line.",
});

// ── Layer 1: the correction was delivered and consumed ───────────────────
check("correction-was-delivered", (t) => {
  t.steerDelivered(1);
});

// ── Layer 2: what the agent did after the steer ──────────────────────────
// Ceiling is looser than the ai-sdk demo: pi's coding tools (ls/read/grep)
// are chattier than the demo agent's four.
check("reacted-without-thrashing", (t) => {
  t.afterSteer(1, (t2) => {
    t2.maxToolCalls(20);
  });
});

// ── Layer 3: the deliverable incorporates the correction ─────────────────
// The report MAY mention 11,480.00 in prose (a good agent flags the conflict);
// the TOTAL line is what the steer must have corrected.
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
check("correction-is-coherent", async (t, { deliverables }) => {
  const report = String((deliverables.result as { summary: string }).summary);
  await t.judge(
    report,
    "PASS only if this monthly revenue report consistently excludes cancelled orders: every total and the final 'Total revenue' line count completed orders only (9,200.00), cancelled orders (2,280.00) are either excluded or explicitly broken out as non-revenue, and the report reads as a coherent whole rather than a correction pasted on top. FAIL if any revenue total still includes cancelled amounts, or if the report acknowledges the instruction without applying it.",
  );
});
