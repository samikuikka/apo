import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — cascade-mode case. Read-off criteria (present or
 * absent in the memo, no derivation) judged under
 * `judge: { mode: "cascade" }`: with a second judge armed
 * (APO_SECOND_JUDGE_MODEL=typesafe/jev-1.13) the decision model answers
 * first and a confident verdict stands without the primary LLM — the
 * check report records `verdict_by`. Without a second judge the mode is
 * inert and the primary judges everything (fail-open). Run-of-show for
 * the cost tier inside the dogfooding project. Ground truth per
 * criterion is fixed by construction.
 *
 *   APO_SECOND_JUDGE_MODEL=typesafe/jev-1.13 \
 *     apo task run jq-cascade-readoff --dir e2e/agent-task-demo
 */

const MEMO = `# Release Notes — 3.4.1

## What ships

Version 3.4.1 replaces the legacy sync importer with the streaming
pipeline. Rollout starts in eu-west-1 and expands to other regions after
a 24-hour soak.

## Operations

The maintenance window moves to 02:00–04:00 UTC. Deploy ships with
LEGACY_AUTH=0; flip it back only for the fallback path.

## Known issues

The metrics dashboard lags up to five minutes behind ingest. No other
regressions reported.
`;

const stubAdapter = defineAdapter({
  name: "md-stub",
  deliverables: { memo: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the release notes" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ memo: MEMO }),
});

const { test } = task("jq-cascade-readoff", {
  adapter: stubAdapter,
  judge: { mode: "cascade" },
  description:
    "Judge-quality battery: read-off criteria under cascade mode — confident second-judge verdicts without the primary call.",
  metadata: { category: "judge-quality", ground_truth: "mixed", mode: "cascade" },
  deliverables: ["memo"],
});

// --- present in the memo: ground truth PASS ---

test("names-version", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The notes name the released version as 3.4.1.");
});

test("window-utc", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The notes state a maintenance window of 02:00–04:00 UTC.");
});

test("rollout-region-first", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The notes say the rollout begins in eu-west-1 before other regions.");
});

// --- absent from the memo: ground truth FAIL, caught via polarity ---

test("migration-rollback-detail", async (t, { deliverables }) => {
  await t.judge(
    deliverables.memo,
    "The notes describe a detailed database migration rollback procedure.",
    { expect: "fail" },
  );
});

test("pricing-change", async (t, { deliverables }) => {
  await t.judge(deliverables.memo, "The notes announce a pricing change.", { expect: "fail" });
});
