import { test } from "../../src/agent-task/public.ts";

// Fixture for loadAndRunFlowChecks end-to-end: line numbers below are
// asserted by the test, so keep this layout stable.
test("fails-on-assertion", (t) => {
  t.calledTool("nope"); // line 5
});

test("passes-check", (t) => {
  t.usedNoTools(); // line 9 — no tools in the empty flow
});

// A judge call split across lines so the test can prove the failure location
// is pinned to the `await t.judge(` line, not the closing `);`.
test("judge-line", async (t) => {
  await t.judge(
    "x",
    "PASS when correct",
  );
});
