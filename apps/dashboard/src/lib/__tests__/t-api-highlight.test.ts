import { describe, expect, it } from "vitest";
import { findTApiSpans, tApiRegex } from "../t-api-highlight";
import { TEST_METHOD_NAMES as DASHBOARD_METHODS } from "../t-api-methods";
// Test-time-only import — vitest resolves the workspace pkg; this never enters
// the browser bundle. The SDK is the single source of truth; the dashboard
// keeps a local copy (see t-api-methods.ts) only to avoid bundling the SDK's
// server runtime. This assertion is the drift guard.
import { TEST_METHOD_NAMES as SDK_METHODS } from "@apo/sdk/agent-task";

/**
 * Regression tests for the colorizer drift bug: the dashboard used to keep its
 * own hardcoded list of ``t.*`` method names, which fell out of sync with the
 * SDK's {@link TestContext} and left ``t.maxTurns`` / ``t.maxDurationMs`` (and
 * four others) unstyled.
 */
describe("t.* method list (drift guard)", () => {
  it("dashboard copy matches the SDK canonical export exactly", () => {
    expect([...DASHBOARD_METHODS].sort()).toEqual([...SDK_METHODS].sort());
  });

  it("has no duplicates", () => {
    expect(new Set(DASHBOARD_METHODS).size).toBe(DASHBOARD_METHODS.length);
  });
});

describe("findTApiSpans", () => {
  it("highlights every method on the dashboard list (no drift)", () => {
    for (const method of DASHBOARD_METHODS) {
      const source = `  t.${method}();`;
      const spans = findTApiSpans(source);
      expect(spans, `expected a span for t.${method}`).toHaveLength(1);
      const [from, to] = spans[0]!;
      expect(source.slice(from, to)).toBe(`t.${method}`);
    }
  });

  it("specifically colorizes the methods that were previously dropped", () => {
    // Direct regression assertions for the exact bug reported.
    const dropped = ["maxTurns", "maxDurationMs", "usedNoTools", "loadedSkill", "calledSubagent", "messageIncludes"];
    const source = dropped.map((m) => `t.${m}`).join("; ");
    const spans = findTApiSpans(source);
    expect(spans).toHaveLength(dropped.length);
  });

  it("does not highlight non-method property access on t", () => {
    expect(findTApiSpans("t.unknownMethod")).toHaveLength(0);
    expect(findTApiSpans("t.foo = 1")).toHaveLength(0);
  });

  it("does not match the word boundary prefix on identifiers like 'att.check'", () => {
    expect(findTApiSpans("att.check")).toHaveLength(0);
    expect(findTApiSpans("const t = 1; t.check")).toHaveLength(1);
  });

  it("matches multiple calls on one line", () => {
    const spans = findTApiSpans("t.check(x); t.maxTurns(3); t.judge(v, 'rubric')");
    expect(spans).toHaveLength(3);
  });

  it("tApiRegex is globally flagged for iterative exec use", () => {
    expect(tApiRegex.global).toBe(true);
  });
});

