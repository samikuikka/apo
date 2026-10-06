import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * Cascade judge demo — `judge: { mode: "cascade" }` at the task level.
 *
 * With a second judge armed (`APO_SECOND_JUDGE_MODEL=typesafe/jev-1.13`),
 * every `t.judge` test in this task is first offered to the decision model:
 * a confident verdict (native confidence >= 0.95) stands without calling the
 * LLM judge, and the check report says so (`judge.verdict_by:
 * "second-judge"`, the decision model in `judge.model`, reasoning notes the
 * primary was not called). Anything the decision model is unsure about —
 * or if it is unreachable — falls through to the primary judge unchanged.
 *
 *   APO_SECOND_JUDGE_MODEL=typesafe/jev-1.13 \
 *     apo task run t-jev-cascade --dir e2e/agent-task-demo
 *
 * Without a second judge the mode is inert and the primary judges
 * everything, byte-identical to a plain `t.judge`. The criteria below are
 * read-off facts — present or absent in the memo, no derivation — which is
 * the shape decision models judge confidently; that is what makes this task
 * a stable cascade demo. (Derived-verdict criteria — computed numbers, code
 * correctness — should be authored as `t.agent` or deterministic tests
 * instead; see the Judging docs page.)
 */

const MEMO = `# API Change Memo — v2.6

## Breaking change

BC-2210 removes the deprecated \`/v1/reports/sync\` endpoint. Clients must
migrate to \`/v1/reports/stream\`, which returns the same payload shape.

## Rollback

Deploy ships with \`REPORTS_V1_COMPAT=1\`, which restores the sync endpoint
for one release cycle. Remove the flag in v2.7.

## Timeline

Staging: Oct 14. Production: Oct 28, after the client migration window.
`;

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

const { test } = task("t-jev-cascade", {
  adapter: stubAdapter,
  judge: { mode: "cascade" },
  description: "Cascade judge demo: read-off criteria decided by the second judge.",
  metadata: { category: "demo", probe: "cascade" },
  deliverables: ["memo"],
});

test("names-deprecated-endpoint", async (t, { deliverables }) => {
  await t.judge(
    deliverables.memo,
    "PASS if the memo names the deprecated endpoint (/v1/reports/sync) and its replacement. FAIL otherwise.",
  );
});

test("has-rollback-section", async (t, { deliverables }) => {
  await t.judge(
    deliverables.memo,
    "PASS if the memo contains a rollback section that states a concrete way to keep the old endpoint available. FAIL otherwise.",
  );
});

test("states-change-id", async (t, { deliverables }) => {
  await t.judge(
    deliverables.memo,
    "PASS if the memo states the breaking change identifier (BC-2210). FAIL otherwise.",
  );
});

test("mentions-security-review", async (t, { deliverables }) => {
  await t.judge(
    deliverables.memo,
    "PASS if the memo mentions a security review of the change. FAIL otherwise.",
  );
});
