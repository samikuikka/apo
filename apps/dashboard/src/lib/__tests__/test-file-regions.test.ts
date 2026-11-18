import { describe, expect, it } from "vitest";
import type { CheckResult, TaskFileContentResponse } from "../agent-task-api";
import {
  buildFileDiagnostics,
  buildTestFileModel,
  testRegionVerdict,
} from "../test-file-regions";

// Synthetic eval file with the shapes a run page meets: two describes, a bare
// top-level test, and (via the checks below) one failing check with a located
// assertion plus one test this run never recorded a result for.
const SOURCE = [
  'import { test, describe } from "@apo-ai/sdk";',
  "",
  'describe("Suite One", () => {',
  '  test("passes", (t) => {',
  '    t.check("value", 1);',
  "  });",
  "",
  '  test("fails", (t) => {',
  '    t.expect(has(deliverables, "answer"));',
  '    t.judge("quality");',
  "  });",
  "});",
  "",
  'describe("Suite Two", () => {',
  '  test("never-ran", (t) => {',
  '    t.check("count", 2);',
  "  });",
  "});",
  "",
  'test("bare passing", (t) => {',
  '  t.check("bare", 3);',
  "});",
].join("\n");

function makeSource(): TaskFileContentResponse {
  return {
    name: "demo.eval.ts",
    path: "tasks/demo/demo.eval.ts",
    content: SOURCE,
    size_bytes: SOURCE.length,
    language: "typescript",
    lines: SOURCE.split("\n").length,
  };
}

function check(partial: Partial<CheckResult>): CheckResult {
  return { id: "", pass: false, reasoning: "", ...partial } as CheckResult;
}

describe("buildTestFileModel", () => {
  it("nests test regions inside their describes with whole-file line ranges", () => {
    const model = buildTestFileModel(makeSource(), []);
    expect(model.regions.map((r) => r.kind)).toEqual([
      "describe",
      "describe",
      "test",
    ]);
    const [suiteOne, suiteTwo, bare] = model.regions;
    expect(suiteOne.name).toBe("Suite One");
    expect(suiteOne.startLine).toBe(3);
    expect(suiteOne.endLine).toBe(12);
    expect(suiteOne.children.map((c) => c.name)).toEqual(["passes", "fails"]);
    expect(suiteOne.children[0]).toMatchObject({ startLine: 4, endLine: 6 });
    expect(suiteOne.children[1]).toMatchObject({ startLine: 8, endLine: 11 });
    expect(suiteTwo).toMatchObject({ name: "Suite Two", startLine: 14, endLine: 18 });
    expect(suiteTwo.children[0]).toMatchObject({ name: "never-ran", startLine: 15, endLine: 17 });
    expect(bare).toMatchObject({ name: "bare passing", startLine: 20, endLine: 22 });
  });

  it("maps recorded checks onto the test that declares them", () => {
    const model = buildTestFileModel(makeSource(), [
      check({ id: "passes", pass: true }),
      check({ id: "fails", pass: false }),
    ]);
    const [suiteOne, , bare] = model.regions;
    expect(suiteOne.children[0].checks.map((c) => c.id)).toEqual(["passes"]);
    expect(suiteOne.children[1].checks.map((c) => c.id)).toEqual(["fails"]);
    expect(bare.checks).toHaveLength(0);
    expect(model.unmapped).toHaveLength(0);
  });

  it("maps a generated-title check via its recorded location line", () => {
    // Table-driven evals register checks whose id never appears in the file;
    // the recorded location line is the only anchor (line 16 sits inside
    // "never-ran").
    const model = buildTestFileModel(makeSource(), [
      check({ id: "R-07", pass: false, location: { file: "demo.eval.ts", line: 16 } }),
    ]);
    const suiteTwo = model.regions[1];
    expect(suiteTwo.children[0].checks.map((c) => c.id)).toEqual(["R-07"]);
  });

  it("reports checks it cannot locate as unmapped", () => {
    const model = buildTestFileModel(makeSource(), [
      check({ id: "registered-in-a-helper", pass: true }),
    ]);
    expect(model.unmapped.map((c) => c.id)).toEqual(["registered-in-a-helper"]);
    expect(model.regions.every((r) => r.checks.length === 0 && r.children.every((c) => c.checks.length === 0))).toBe(true);
  });
});

describe("testRegionVerdict", () => {
  const model = buildTestFileModel(makeSource(), [
    check({ id: "passes", pass: true }),
    check({
      id: "fails",
      pass: false,
      assertions: [
        {
          id: "has-answer",
          pass: false,
          reasoning: "no answer deliverable",
          expected: "an answer",
          received: "missing",
          location: { file: "demo.eval.ts", line: 9 },
        },
      ],
    }),
    check({ id: "bare passing", pass: true }),
  ]);
  const [suiteOne, suiteTwo, bare] = model.regions;

  it("passes when every mapped check passed", () => {
    expect(testRegionVerdict(suiteOne.children[0])).toBe("pass");
    expect(testRegionVerdict(bare)).toBe("pass");
  });

  it("fails when any mapped check failed", () => {
    expect(testRegionVerdict(suiteOne.children[1])).toBe("fail");
  });

  it("reads as no-result for a test with no recorded check", () => {
    expect(testRegionVerdict(suiteTwo.children[0])).toBe("no-result");
  });
});

describe("buildFileDiagnostics", () => {
  it("marks passed openers green, failed openers red, failing assertion lines red with values", () => {
    const model = buildTestFileModel(makeSource(), [
      check({ id: "passes", pass: true }),
      check({
        id: "fails",
        pass: false,
        reasoning: "the answer was absent",
        assertions: [
          {
            id: "has-answer",
            pass: false,
            reasoning: "no answer deliverable",
            expected: "an answer",
            received: "missing",
            location: { file: "demo.eval.ts", line: 9 },
          },
          {
            id: "judge",
            pass: false,
            reasoning: "quality below bar",
            location: { file: "demo.eval.ts", line: 99 },
          },
        ],
      }),
      check({ id: "bare passing", pass: true }),
    ]);

    expect(buildFileDiagnostics(model)).toEqual([
      { line: 4, severity: "info", message: "passes passed" },
      {
        line: 8,
        severity: "error",
        message: "fails failed",
        reasoning: "the answer was absent",
      },
      {
        line: 9,
        severity: "error",
        message: "no answer deliverable",
        label: "has-answer",
        expected: "an answer",
        received: "missing",
      },
      { line: 15, severity: "warning", message: "never-ran: no result in this run" },
      { line: 20, severity: "info", message: "bare passing passed" },
    ]);
  });

  it("marks every test amber when the run recorded zero checks", () => {
    const model = buildTestFileModel(makeSource(), []);
    expect(buildFileDiagnostics(model)).toEqual([
      { line: 4, severity: "warning", message: "passes: no result in this run" },
      { line: 8, severity: "warning", message: "fails: no result in this run" },
      { line: 15, severity: "warning", message: "never-ran: no result in this run" },
      { line: 20, severity: "warning", message: "bare passing: no result in this run" },
    ]);
  });
});
