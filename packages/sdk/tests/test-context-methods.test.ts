import { describe, it, expect } from "vitest";
import { createTestContext, TEST_METHOD_NAMES } from "../src/agent-task/checks/t.ts";
import { Recorder } from "../src/agent-task/checks/recorder.ts";
import { FlowView } from "../src/agent-task/flow/view.ts";
import type { Flow } from "../src/agent-task/flow/types.ts";

const emptyFlow: Flow = { events: [] };

/**
 * Regression guard for the dashboard colorizer bug: ``t.maxTurns`` /
 * ``t.maxDurationMs`` rendered plain white because the frontend kept its own
 * copy of the method-name list, which drifted out of sync with the interface.
 *
 * TEST_METHOD_NAMES is now the single source of truth. These tests pin it to
 * the live ``t`` object so the two can never diverge again.
 */
describe("TEST_METHOD_NAMES", () => {
  it("lists exactly the methods present on a live TestContext", () => {
    const rec = new Recorder();
    const t = createTestContext(new FlowView(emptyFlow), rec);
    const liveKeys = (Object.keys(t) as string[]).sort();
    expect([...TEST_METHOD_NAMES].sort()).toEqual(liveKeys);
  });

  it("has no duplicates", () => {
    expect(new Set(TEST_METHOD_NAMES).size).toBe(TEST_METHOD_NAMES.length);
  });

  it("includes the methods that were previously dropped by the dashboard", () => {
    // Direct regression assertions for the exact bug the user reported.
    expect(TEST_METHOD_NAMES).toContain("maxTurns");
    expect(TEST_METHOD_NAMES).toContain("maxDurationMs");
    expect(TEST_METHOD_NAMES).toContain("usedNoTools");
    expect(TEST_METHOD_NAMES).toContain("loadedSkill");
    expect(TEST_METHOD_NAMES).toContain("calledSubagent");
    expect(TEST_METHOD_NAMES).toContain("messageIncludes");
  });
});
