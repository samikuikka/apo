/**
 * Two-phase execution split, tested against the production projection tee.
 *
 * Phase 1 (capture): the adapter runs, spans flow through the tee, the root
 * span ends. Phase 2 (evaluate): checks run against the frozen snapshot.
 *
 * - a check sees spans recorded during capture (capture completes before
 *   evaluation)
 * - evaluation does not contaminate the captured trace — running checks
 *   leaves the snapshot byte-identical, and no evaluation spans appear in it
 *
 * These guarantees used to be tested through the removed
 * LocalTraceProjectionRecorder, which had drifted from the production tee
 * (capability semantics and snapshot shape had diverged).
 */
import { describe, it, expect } from "vitest";
import { createProjectionTee } from "../src/agent-task/trace-projection/projection-tee.ts";
import { createNoopAgentTaskTraceContext } from "../src/agent-task/tracing.ts";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";

function recordToolDuringCapture(
  teeTrace: ReturnType<typeof createProjectionTee>["trace"],
): void {
  const toolId = teeTrace.createSpan({
    task_id: "tool.read_file",
    step_name: "read_file",
    observation_type: "TOOL",
  });
  teeTrace.endSpan(toolId, { level: "DEFAULT", metadata: { tool_name: "read_file" } });
  teeTrace.endRoot();
}

describe("two-phase split (production tee)", () => {
  it("a check sees spans recorded during capture", async () => {
    const tee = createProjectionTee(createNoopAgentTaskTraceContext());

    // Phase 1: capture, then freeze.
    recordToolDuringCapture(tee.trace);
    const snapshot = tee.getSnapshot();

    // Phase 2: evaluate the frozen snapshot.
    resetFlowChecks();
    defineCheck("post-trace-check", (t) => {
      t.calledTool("read_file");
    });
    const results = await runTraceChecks({ snapshot, deliverables: {} });

    expect(results).toHaveLength(1);
    expect(results[0]!.pass).toBe(true);
  });

  it("running checks does not contaminate the captured trace", async () => {
    const tee = createProjectionTee(createNoopAgentTaskTraceContext());
    recordToolDuringCapture(tee.trace);

    const before = tee.getSnapshot();
    const observationsBefore = JSON.stringify(before.observations);

    resetFlowChecks();
    defineCheck("reads-only", (t) => {
      t.calledTool("read_file");
    });
    await runTraceChecks({ snapshot: before, deliverables: {} });

    const after = tee.getSnapshot();
    // Timing fields (trace.durationMs) are derived at snapshot time, so
    // compare the observations themselves: evaluation must add, remove, or
    // modify none of them.
    expect(JSON.stringify(after.observations)).toBe(observationsBefore);
    const spanNames = after.observations.map((o) => o.name);
    expect(spanNames).toContain("read_file");
    expect(spanNames).not.toContain("checks.run");
    expect(spanNames).not.toContain("deliverables.validate");
  });
});
