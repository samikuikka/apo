/**
 * Benchmarks for the Trace Projection read model.
 *
 * `TraceView` is the read side every projection-first assertion goes through:
 * one deterministic sort of the observations, then derived views (tool calls,
 * messages, skills, subagents) on top of it. Its cost scales with trace size,
 * so it is the SDK's main "big trace" path.
 */

import { bench, describe } from "vitest";

import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import { createTraceTestContext } from "../src/agent-task/checks/t.ts";
import { Recorder } from "../src/agent-task/checks/recorder.ts";
import { buildSnapshot } from "./fixtures.ts";

// 250 observations ≈ a long agent run: big enough that the sort and the
// derived scans dominate, small enough to stay a sub-second benchmark.
const SNAPSHOT = buildSnapshot(250);
const WARM_VIEW = new TraceView(SNAPSHOT);
// Force the memoized sort so the "derived views" benchmarks measure the
// derivations rather than the one-time sort.
void WARM_VIEW.toolCalls;

describe("trace-projection", () => {
  bench("TraceView cold sort + toolCalls over 250 observations", () => {
    const view = new TraceView(SNAPSHOT);
    void view.toolCalls;
  });

  bench("TraceView derived views on a warm 250-observation trace", () => {
    void WARM_VIEW.messages;
    void WARM_VIEW.toolNamesInOrder;
    void WARM_VIEW.skillLoads;
    void WARM_VIEW.subagentCalls;
    void WARM_VIEW.reply;
    void WARM_VIEW.turnCount;
    void WARM_VIEW.failedActions;
    void WARM_VIEW.durationMs;
  });

  bench("assertion pass over a 250-observation trace", () => {
    const view = new TraceView(SNAPSHOT);
    const t = createTraceTestContext(view, new Recorder());
    t.calledTool("search_invoices_0");
    t.calledTool(/^search_invoices_/);
    t.notCalledTool("delete_everything");
    t.toolOrder(["search_invoices_0", "search_invoices_1", "search_invoices_2"]);
    t.maxToolCalls(100);
    t.noFailedActions();
    t.loadedSkill("skill.step.3");
    t.calledSubagent("agent.step.2");
    t.messageIncludes("assistant reply");
    t.maxTurns(100);
    t.maxDurationMs(10_000);
  });
});
