import { describe, expect, it } from "vitest";
import { buildCheckDiagnostics, shouldShowDiff, isJudgeDiagnostic } from "../check-diagnostics";

describe("buildCheckDiagnostics", () => {
  it("maps every failed assertion onto its local checks.ts line", () => {
    const diagnostics = buildCheckDiagnostics(
      {
        id: "quality",
        pass: false,
        reasoning: "two assertions failed",
        assertions: [
          {
            id: "judge",
            pass: false,
            reasoning: "missing evidence",
            evaluator_type: "llm",
            location: { file: "checks.ts", line: 14, column: 9 },
          },
          {
            id: "calledTool",
            pass: false,
            reasoning: "read_file was not called",
            evaluator_type: "code",
            location: { file: "checks.ts", line: 16 },
          },
        ],
      },
      10,
      18,
    );

    expect(diagnostics).toEqual([
      {
        line: 5,
        column: 9,
        message: "missing evidence",
        severity: "error",
        label: "judge",
        expected: undefined,
        received: undefined,
        reasoning: "missing evidence",
        evaluator_type: "llm",
      },
      {
        line: 7,
        column: undefined,
        message: "read_file was not called",
        severity: "error",
        label: "calledTool",
        expected: undefined,
        received: undefined,
        reasoning: "read_file was not called",
        evaluator_type: "code",
      },
    ]);
  });

  it("falls back to the check-level location for historical results", () => {
    expect(
      buildCheckDiagnostics(
        {
          id: "legacy",
          pass: false,
          reasoning: "failed",
          location: { file: "checks.ts", line: 22 },
        },
        20,
        25,
      ),
    ).toEqual([
      {
        line: 3,
        column: undefined,
        message: "failed",
        severity: "error",
        label: "legacy",
        expected: undefined,
        received: undefined,
        reasoning: undefined,
        evaluator_type: "code",
      },
    ]);
  });

  it("uses expected/received for t.check failures without prose reasoning", () => {
    const diagnostics = buildCheckDiagnostics(
      {
        id: "maxToolCalls",
        pass: false,
        reasoning: "",
        assertions: [
          {
            id: "maxToolCalls(40)",
            pass: false,
            reasoning: "",
            expected: "≤ 40 tool calls",
            received: "52",
            evaluator_type: "code",
            location: { file: "checks.ts", line: 3 },
          },
        ],
      },
      1,
      10,
    );
    expect(diagnostics).toEqual([
      {
        line: 3,
        column: undefined,
        message: "expected ≤ 40 tool calls · received 52",
        severity: "error",
        label: "maxToolCalls(40)",
        expected: "≤ 40 tool calls",
        received: "52",
        reasoning: undefined,
        evaluator_type: "code",
      },
    ]);
  });

  it("prefers judge reasoning over expected/received for t.judge failures", () => {
    const diagnostics = buildCheckDiagnostics(
      {
        id: "config-meets-requirements",
        pass: false,
        reasoning: "",
        assertions: [
          {
            id: "judge",
            pass: false,
            reasoning: "Findings are generic, no specific values referenced.",
            expected: "PASS if values reference the requirements",
            received: "[SERVICE_NAME: payment-gateway, ...]",
            evaluator_type: "llm",
            judge: { model: "google/gemini-2.5-flash" },
            location: { file: "checks.ts", line: 24, column: 3 },
          },
        ],
      },
      20,
      30,
    );
    expect(diagnostics).toEqual([
      {
        line: 5,
        column: 3,
        message: "Findings are generic, no specific values referenced.",
        severity: "error",
        label: "judge",
        expected: "PASS if values reference the requirements",
        received: "[SERVICE_NAME: payment-gateway, ...]",
        reasoning: "Findings are generic, no specific values referenced.",
        evaluator_type: "llm",
      },
    ]);
  });

  it("re-derives the line from the CURRENT source, ignoring a stale stored location", () => {
    const code = `check("c", (t) => {
  t.calledTool("read_file");
  t.calledTool("search_content");
  t.maxToolCalls(MAX_TOOL_CALLS);
});`;
    const diagnostics = buildCheckDiagnostics(
      {
        id: "c",
        pass: false,
        reasoning: 'expected at least one "search_content" call, got 0',
        assertions: [
          {
            id: 'calledTool("search_content")',
            pass: false,
            reasoning: 'expected at least one "search_content" call, got 0',
            expected: '≥1 "search_content" call',
            received: "0",
            evaluator_type: "code",
            location: { file: "checks.ts", line: 99 },
          },
        ],
      },
      10,
      14,
      code,
    );
    // search_content is block line 3 → the marker lands there, NOT on a
    // comment and NOT on the stale line 99.
    expect(diagnostics).toEqual([
      expect.objectContaining({
        line: 3,
        label: 'calledTool("search_content")',
        severity: "error",
      }),
    ]);
  });

  it("emits green info markers for t.judge passes alongside red errors for failures", () => {
    // Marker policy: failures always get red markers, but only Judge
    // passes earn green markers. A passing t.check() / t.calledTool() is
    // baseline OK and should not clutter the gutter — its line stays plain.
    const diagnostics = buildCheckDiagnostics(
      {
        id: "mixed-check",
        pass: false,
        reasoning: "1 judge + 1 t.check failed",
        assertions: [
          // Passing t.calledTool — should NOT get any marker.
          {
            id: "calledTool('read_file')",
            pass: true,
            reasoning: "",
            evaluator_type: "code",
            location: { file: "checks.ts", line: 4 },
          },
          // Passing t.judge — should get a green info marker.
          {
            id: "judge",
            pass: true,
            reasoning: "Findings reference specific values.",
            evaluator_type: "llm",
            judge: { model: "google/gemini-2.5-flash" },
            location: { file: "checks.ts", line: 5 },
          },
          // Failing t.check — should get a red error marker.
          {
            id: "maxToolCalls(40)",
            pass: false,
            reasoning: "",
            expected: "≤ 40 tool calls",
            received: "52",
            evaluator_type: "code",
            location: { file: "checks.ts", line: 6 },
          },
        ],
      },
      1,
      10,
    );
    expect(diagnostics).toEqual([
      {
        line: 5,
        column: undefined,
        message: "passed",
        severity: "info",
        label: "judge",
        expected: undefined,
        received: undefined,
        reasoning: "Findings reference specific values.",
        evaluator_type: "llm",
      },
      {
        line: 6,
        column: undefined,
        message: "expected ≤ 40 tool calls · received 52",
        severity: "error",
        label: "maxToolCalls(40)",
        expected: "≤ 40 tool calls",
        received: "52",
        reasoning: undefined,
        evaluator_type: "code",
      },
    ]);
  });

  it("positions a FAILING judge on the `await t.judge(` line via source-derivation", () => {
    const code = `check("grounded", async (t, { deliverables }) => {
  t.calledTool("read_file", { input: { path: /source\\.py/ } });
  await t.judge(
    deliverables.result.findings,
    "PASS when grounded",
  );
});`;
    const diagnostics = buildCheckDiagnostics(
      {
        id: "grounded",
        pass: false,
        reasoning: "findings are generic",
        assertions: [
          {
            id: "judge",
            pass: false,
            reasoning: "findings are generic",
            expected: "PASS when grounded",
            received: "[generic...]",
            evaluator_type: "llm",
            judge: { model: "x/y" },
            location: { file: "checks.ts", line: 1 },
          },
        ],
      },
      1,
      6,
      code,
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ line: 3, severity: "error", label: "judge" }),
    ]);
  });

  it("positions a PASSING judge on the `await t.judge(` line with info severity", () => {
    const code = `check("grounded", async (t, { deliverables }) => {
  t.calledTool("read_file", { input: { path: /source\\.py/ } });
  await t.judge(
    deliverables.result.findings,
    "PASS when grounded",
  );
});`;
    const diagnostics = buildCheckDiagnostics(
      {
        id: "grounded",
        pass: true,
        reasoning: "passed",
        assertions: [
          {
            id: "judge",
            pass: true,
            reasoning: "Findings reference specific code.",
            expected: "PASS when grounded",
            received: "[specific...]",
            evaluator_type: "llm",
            judge: { model: "x/y" },
            location: { file: "checks.ts", line: 1 },
          },
        ],
      },
      1,
      6,
      code,
    );
    // Passing judge still earns a (green) marker on the judge line.
    expect(diagnostics).toEqual([
      expect.objectContaining({ line: 3, severity: "info", label: "judge" }),
    ]);
  });
});

describe("shouldShowDiff", () => {
  // The Expected/Received diff is a FAILURE presentation. A passing judge
  // carries expected/received data, but showing it as a diff makes a pass look
  // like a mistake — so the renderer must only diff failures.
  it("shows the diff for error (failure) diagnostics", () => {
    expect(shouldShowDiff({ severity: "error" })).toBe(true);
  });

  it("hides the diff for info (passing) diagnostics", () => {
    expect(shouldShowDiff({ severity: "info" })).toBe(false);
  });
});

describe("isJudgeDiagnostic", () => {
  // Judges get a verdict+rubric presentation (no value-diff); t.check/t.calledTool
  // keep the diff. The split is driven by evaluator_type carried on the diagnostic.
  it("is true for LLM judge assertions", () => {
    expect(isJudgeDiagnostic({ evaluator_type: "llm" })).toBe(true);
  });

  it("is false for code assertions (and when evaluator_type is absent)", () => {
    expect(isJudgeDiagnostic({ evaluator_type: "code" })).toBe(false);
    expect(isJudgeDiagnostic({})).toBe(false);
  });
});

describe("buildCheckDiagnostics — evaluator_type carried through", () => {
  it("tags judge vs code assertions so the renderer can split them", () => {
    const code = `check("c", async (t) => {
  await t.judge(deliverables.result, "PASS when grounded");
  t.calledTool("read_file");
});`;
    const diagnostics = buildCheckDiagnostics(
      {
        id: "c",
        pass: false,
        reasoning: "failed",
        assertions: [
          {
            id: "judge",
            pass: false,
            reasoning: "findings are generic",
            expected: "PASS when grounded",
            received: "[generic...]",
            evaluator_type: "llm",
            judge: { model: "x/y" },
            location: { file: "checks.ts", line: 1 },
          },
          {
            id: 'calledTool("read_file")',
            pass: false,
            reasoning: "no read_file call",
            expected: '≥1 "read_file" call',
            received: "0",
            evaluator_type: "code",
            location: { file: "checks.ts", line: 1 },
          },
        ],
      },
      1,
      3,
      code,
    );
    const judge = diagnostics.find((d) => d.label === "judge");
    const call = diagnostics.find((d) => d.label === 'calledTool("read_file")');
    expect(judge?.evaluator_type).toBe("llm");
    expect(call?.evaluator_type).toBe("code");
  });

  it("recovers judge reasoning from the raw response when assertion.reasoning is empty", () => {
    const diagnostics = buildCheckDiagnostics(
      {
        id: "grounded",
        pass: false,
        reasoning: "",
        assertions: [
          {
            id: "judge",
            pass: false,
            reasoning: "",
            evaluator_type: "llm",
            judge: {
              model: "x/y",
              response: '[{"pass": false, "reasoning": "Value 1 fails because it is generic"}]',
            },
            location: { file: "checks.ts", line: 1 },
          },
        ],
      },
      1,
      3,
    );
    expect(diagnostics[0]?.reasoning).toBe("Value 1 fails because it is generic");
  });
});
