import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
  loadAndRunFlowChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { parseCheckLocation } from "../src/agent-task/checks/location.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_CHECKS = join(__dirname, "fixtures/checks.ts");

// A minimal message-only snapshot → no tool calls, so tool assertions fail.
const emptySnapshot: TraceProjectionSnapshot = {
  schemaVersion: 1,
  projectionVersion: 1,
  source: "local",
  trace: {
    traceId: "test",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    complete: true,
  },
  capabilities: {
    messages: "available",
    tools: "available",
    errors: "available",
    timing: "available",
    skills: "available",
    subagents: "available",
  },
  observations: [
    { spanId: "s1", type: "GENERATION", name: "user", status: "unset", messages: [{ role: "user", content: "hi" }] },
    { spanId: "s2", type: "GENERATION", name: "assistant", status: "unset", messages: [{ role: "assistant", content: "hey" }] },
  ],
};

describe("parseCheckLocation", () => {
  const url = "file:///tmp/checks.ts.123-abc.ts";

  it("extracts line + column from the first matching frame", () => {
    const stack = `Error: x\n    at fn (${url}:7:15)\n    at other (file:///other.ts:1:1)`;
    expect(parseCheckLocation(stack, url, "checks.ts")).toEqual({
      file: "checks.ts",
      line: 7,
      column: 15,
    });
  });

  it("picks the FIRST matching frame (closest to the failure)", () => {
    const stack = `Error: x\n    at a (${url}:3:5)\n    at b (${url}:9:2)`;
    expect(parseCheckLocation(stack, url, "checks.ts")?.line).toBe(3);
  });

  it("returns undefined when no frame matches the module URL", () => {
    const stack = `Error: x\n    at fn (file:///other.ts:1:1)`;
    expect(parseCheckLocation(stack, url, "checks.ts")).toBeUndefined();
  });

  it("returns undefined for empty / missing stacks", () => {
    expect(parseCheckLocation(undefined, url, "checks.ts")).toBeUndefined();
    expect(parseCheckLocation("", url, "checks.ts")).toBeUndefined();
  });

  it("returns undefined when moduleUrl is empty", () => {
    expect(parseCheckLocation("Error: x", "", "checks.ts")).toBeUndefined();
  });
});

describe("runTraceChecks — location capture", () => {
  // The checks below are defined in THIS file, so their stacks carry this
  // module's URL. Passing moduleUrl = import.meta.url makes the locator
  // resolve them. (Exact source line is environment-dependent under test
  // transforms, so we assert presence + file, not a hard line number.)
  const MODULE_URL = import.meta.url;
  const DISPLAY_FILE = "check-location.test.ts";

  it("attaches a location for a thrown error", async () => {
    resetFlowChecks();
    defineCheck("throws", () => {
      throw new Error("boom");
    });
    const [r] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      moduleUrl: MODULE_URL,
      displayFile: DISPLAY_FILE,
    });
    expect(r.pass).toBe(false);
    expect(r.reasoning).toContain("boom");
    expect(r.location).toBeDefined();
    expect(r.location?.file).toBe(DISPLAY_FILE);
    expect(r.location?.line).toBeGreaterThan(0);
    expect(r.source_file).toBe(DISPLAY_FILE);
  });

  it("attaches a location for a failed assertion (not just throws)", async () => {
    resetFlowChecks();
    defineCheck("fails-assertion", (t) => {
      t.calledTool("read_file");
    });
    const [r] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      moduleUrl: MODULE_URL,
      displayFile: DISPLAY_FILE,
    });
    expect(r.pass).toBe(false);
    expect(r.location).toBeDefined();
    expect(r.location?.file).toBe(DISPLAY_FILE);
    expect(r.location?.line).toBeGreaterThan(0);
  });

  it("omits location for a passing check", async () => {
    resetFlowChecks();
    defineCheck("passes", (t) => {
      t.usedNoTools();
    });
    const [r] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      moduleUrl: MODULE_URL,
      displayFile: DISPLAY_FILE,
    });
    expect(r.pass).toBe(true);
    expect(r.location).toBeUndefined();
  });

  it("omits location when no moduleUrl is provided (legacy path)", async () => {
    resetFlowChecks();
    defineCheck("fails", (t) => {
      t.calledTool("read_file");
    });
    const [r] = await runTraceChecks({ snapshot: emptySnapshot, deliverables: {} });
    expect(r.pass).toBe(false);
    expect(r.location).toBeUndefined();
    expect(r.source_file).toBeUndefined();
  });
});

describe("loadAndRunFlowChecks — real file-import path", () => {
  // Drives the actual loader: copy checks.ts to a temp module, import it
  // (which registers checks via side effects), run them, and resolve failure
  // locations from the temp module's stack frames. This is the production
  // path the backend spawns.
  it("resolves a line-precise location + source_file from a real checks file", async () => {
    const results = await loadAndRunFlowChecks(FIXTURE_CHECKS, {
      snapshot: emptySnapshot,
      deliverables: {},
    });

    const failed = results.find((r) => r.id === "fails-on-assertion");
    expect(failed).toBeDefined();
    expect(failed?.pass).toBe(false);
    expect(failed?.source_file).toBe("checks.ts");
    expect(failed?.location).toBeDefined();
    expect(failed?.location?.file).toBe("checks.ts");
    // Line 5 is the failing `t.calledTool("nope")` call (type-stripping
    // preserves source lines). Assert a tight range to stay robust to any
    // off-by-one in tooling while still proving it's the assertion line.
    expect(failed?.location?.line).toBeGreaterThanOrEqual(4);
    expect(failed?.location?.line).toBeLessThanOrEqual(6);
  });

  it("does not attach a location to a passing check", async () => {
    const results = await loadAndRunFlowChecks(FIXTURE_CHECKS, {
      snapshot: emptySnapshot,
      deliverables: {},
    });
    const passed = results.find((r) => r.id === "passes-check");
    expect(passed?.pass).toBe(true);
    expect(passed?.location).toBeUndefined();
  });

  it("pins a judge failure to the `await t.judge(` line, not the closing `);`", async () => {
    // Regression: judge is async and used to capture its location AFTER the
    // await resumed, which made V8 report the caller's frame at the closing
    // `});` instead of the `await t.judge(` line. No judge model is configured
    // here, so the check records a failure — what matters is the line.
    const results = await loadAndRunFlowChecks(FIXTURE_CHECKS, {
      snapshot: emptySnapshot,
      deliverables: {},
    });
    const judgeResult = results.find((r) => r.id === "judge-line");
    expect(judgeResult).toBeDefined();
    // `await t.judge(` is on fixture line 16; the closing `);` is line 19 and
    // the check's `});` is line 20. The location must be at the await line
    // (±1 for tooling), never the closing brace.
    expect(judgeResult?.location?.line).toBeGreaterThanOrEqual(15);
    expect(judgeResult?.location?.line).toBeLessThanOrEqual(17);
  });
});
