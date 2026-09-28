import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * #163 measurement probe — NOT a product task.
 *
 * A stub agent (no LLM) returns one fixed memo, and ten t.judge criteria
 * grade it: ~half calibrated to clearly pass, ~half to clearly fail, two
 * borderline. That gives a fixed deliverable set for A/B re-judging the
 * response-contract elicitation order:
 *
 *   apo runs rejudge <run> --samples 3 --label reasoning-first
 *   APO_JUDGE_VERDICT_FIRST=1 apo runs rejudge <run> --samples 3 \
 *     --label verdict-first
 *
 * Flips between the arms (apo runs judgments <run> --json) are the
 * measurement; the memo never changes, so any verdict movement is the
 * contract, not the agent.
 */

const MEMO = `# Due Diligence Memo — Project Aurora

## Executive summary

Project Aurora is a mid-market software acquisition with contested litigation
exposure and a clean IP position. The data room supports the revenue claims;
the legal overhang does not block signing but must be priced.

## 1. Litigation exposure

Target's litigation counsel (Caldwell & Strauss LLP) estimates probable
exposure at $8.5M–$14M. See the data room index (http://dataroom.example/aurora/index)
for the underlying pleadings summary.

## 2. Risk categories

- Legal: the litigation overhang above; indemnification caps proposed at 1.5x escrow.
- Customer: 22% of ARR concentrated in two accounts, both renewing within 9 months.
- Technology: the core platform runs an EOL framework; migration est. 4 engineer-quarters.

## 3. IP position

Clean. Six granted patents, no encumbrances, all assignments recorded. The
open-source scan flags only permissive licenses.

## Next steps

Confirm escrow sizing with counsel, commission the framework-migration
assessment, and circulate the revised bid before the September board meeting.`;

const stubAdapter = defineAdapter({
  name: "md-stub",
  deliverables: { memo: null },
  // One user turn, then the runner stops (null = no further turns).
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the memo" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ memo: MEMO }),
});

const { test } = task("judge-flip-probe", {
  adapter: stubAdapter,
  description:
    "Fixed-deliverable probe for measuring the judge response-contract elicitation order (#163).",
  metadata: { category: "measurement", probe: "issue-163" },
  deliverables: ["memo"],
});

// --- calibrated to clearly PASS against the fixed memo ---

test("names-target", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The memo names the acquisition target as Project Aurora.");
});

test("litigation-range", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The memo states a litigation exposure range that includes $8.5M.");
});

test("cites-data-room", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The memo cites the data room index URL.");
});

test("three-risk-categories", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The memo lists at least three distinct risk categories with specifics.");
});

test("next-steps-section", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The memo ends with a concrete next-steps section.");
});

// --- calibrated to clearly FAIL against the fixed memo ---

test("recommends-proceeding", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The memo explicitly recommends proceeding with the acquisition.");
});

test("quantifies-synergies", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The memo quantifies expected synergies with a dollar figure.");
});

test("regulatory-timeline", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The memo discusses the regulatory approval timeline for the deal.");
});

// --- borderline ---

test("summary-under-100-words", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The executive summary is under 100 words.");
});

test("iso-dates", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "All dates in the memo use ISO 8601 format (YYYY-MM-DD).");
});
