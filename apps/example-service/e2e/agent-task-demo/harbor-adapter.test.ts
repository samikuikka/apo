/**
 * Showcase test — drives the REAL apo task pipeline against fixed Harbor
 * fixtures, proving the three-way verdict end to end.
 *
 * What this exercises (nothing mocked except the Harbor subprocess):
 *   loadTask → initialize → turn → startSession → sendUserTurn →
 *   collectDeliverables → deliverable validation → check evaluation →
 *   aggregateResult
 *
 * The three scenarios map to issue #20's acceptance criteria:
 *   pass      → reward 1            → apo pass
 *   fail      → reward 0            → apo TEST failure (not an execution error)
 *   malformed → reward missing      → apo EXECUTION error (never coerced to 0)
 *
 * No Docker, network, provider credentials, or Harbor registry required.
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { runTaskDir } from "@apo/sdk/agent-task";

const DEMO_ROOT = import.meta.dirname;
const TASK_DIR = join(
  DEMO_ROOT,
  "tasks/harbor/terminal-bench/count-dataset-tokens",
);
const FIXTURE = (name: string) =>
  join(DEMO_ROOT, "fixtures/harbor", name, "result.json");

const PREV_FIXTURE = process.env.APO_HARBOR_FIXTURE;
afterEach(() => {
  if (PREV_FIXTURE === undefined) delete process.env.APO_HARBOR_FIXTURE;
  else process.env.APO_HARBOR_FIXTURE = PREV_FIXTURE;
});

describe("count-dataset-tokens — full apo pipeline vs Harbor verdict", () => {
  it("passes when the official reward is 1", async () => {
    process.env.APO_HARBOR_FIXTURE = FIXTURE("pass");
    const summary = await runTaskDir(TASK_DIR);

    expect(summary.taskId).toBe("count-dataset-tokens");
    expect(summary.pass).toBe(true);
    expect(summary.checks).toContainEqual(
      expect.objectContaining({
        id: "official-terminal-bench-verifier",
        pass: true,
      }),
    );
  });

  it("FAILS as a test (not an error) when the official reward is 0", async () => {
    process.env.APO_HARBOR_FIXTURE = FIXTURE("fail");
    const summary = await runTaskDir(TASK_DIR);

    // The run completes — it does not throw. The failure is a check verdict.
    expect(summary.pass).toBe(false);
    expect(summary.checks).toContainEqual(
      expect.objectContaining({
        id: "official-terminal-bench-verifier",
        pass: false,
      }),
    );
  });

  it("errors (execution error) when the reward is missing — never coerced to 0", async () => {
    process.env.APO_HARBOR_FIXTURE = FIXTURE("malformed");

    // collectDeliverables throws → runTaskDir rejects. A missing reward is an
    // infrastructure/execution fault, structurally distinct from reward 0.
    await expect(runTaskDir(TASK_DIR)).rejects.toThrow(/reward/i);
  });

  it("records trajectory events from the Harbor trial as diagnostics", async () => {
    process.env.APO_HARBOR_FIXTURE = FIXTURE("pass");
    const summary = await runTaskDir(TASK_DIR);

    // The diagnostic check runs but can never flip the verdict — it only
    // confirms trajectory data was carried through to the apo run.
    expect(summary.checks).toContainEqual(
      expect.objectContaining({
        id: "trajectory-events-recorded-for-trace",
        pass: true,
      }),
    );
    expect(summary.checks).toContainEqual(
      expect.objectContaining({
        id: "provenance-preserved",
        pass: true,
      }),
    );
  });
});
