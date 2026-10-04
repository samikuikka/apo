/**
 * Second-judge rendering in formatChecks — the CLI mirror of the dashboard's
 * "measurements, not diagnoses" language: corroborated checks stay silent,
 * splits show both verdicts plus confidence, unsure cases show a dim mark,
 * and the run gets one fact line.
 */
import { describe, expect, it } from "vitest";
import { formatChecks, secondJudgeSummary } from "../src/lib/checks-format.ts";
import { secondJudgeFacts } from "@apo-ai/sdk/agent-task";
import type { CheckResult, SecondJudgeEvidence } from "../src/lib/agent-task-types.ts";

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return { id: "c-1", pass: true, reasoning: "", ...overrides };
}

function sj(evidence: Partial<SecondJudgeEvidence>): SecondJudgeEvidence {
  return { model: "typesafe/jev-1.13", ...evidence };
}

// ANSI-stripped output so assertions don't depend on color codes.
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("secondJudgeFacts", () => {
  it("no second judge → none", () => {
    expect(secondJudgeFacts(check())).toEqual({ kind: "none" });
  });

  it("error evidence → error", () => {
    const c = check({ judge: { secondJudge: sj({ error: "HTTP 429" }) } });
    expect(secondJudgeFacts(c).kind).toBe("error");
  });

  it("oversize input → skipped, distinct from error", () => {
    const c = check({
      judge: { secondJudge: sj({ skipped: "input ~97,000 tokens exceeds the model's context limit" }) },
    });
    expect(secondJudgeFacts(c).kind).toBe("skipped");
  });

  it("verdicts differ → split with confidence", () => {
    const c = check({ pass: true, judge: { secondJudge: sj({ choice: "fail", confidence: 0.99 }) } });
    expect(secondJudgeFacts(c)).toEqual({ kind: "split", confidence: 0.99 });
  });

  it("agree but low confidence → unsure", () => {
    const c = check({ pass: true, judge: { secondJudge: sj({ choice: "pass", confidence: 0.31 }) } });
    expect(secondJudgeFacts(c)).toEqual({ kind: "unsure", confidence: 0.31 });
  });

  it("agree with confidence → agree", () => {
    const c = check({ pass: true, judge: { secondJudge: sj({ choice: "pass", confidence: 0.98 }) } });
    expect(secondJudgeFacts(c)).toEqual({ kind: "agree", confidence: 0.98 });
  });
});

describe("formatChecks second-judge rendering", () => {
  it("corroborated checks are silent — byte-identical to no-second-judge output", () => {
    const without = formatChecks([check()]);
    const withAgree = formatChecks([
      check({ judge: { secondJudge: sj({ choice: "pass", confidence: 0.98 }) } }),
    ]);
    expect(plain(withAgree)).toBe(plain(without));
  });

  it("split renders both verdict dots, confidence, and the takeaway", () => {
    const out = plain(
      formatChecks([
        check({ pass: true, judge: { secondJudge: sj({ choice: "fail", confidence: 0.99 }) } }),
      ]),
    );
    expect(out).toContain("✓✗ 0.99");
    expect(out).toContain("Verdicts differ — second judge contradicts at 0.99 confidence.");
  });

  it("split on a failing check orders the dots fail-then-pass", () => {
    const out = plain(
      formatChecks([
        check({ pass: false, judge: { secondJudge: sj({ choice: "pass", confidence: 0.93 }) } }),
      ]),
    );
    expect(out).toContain("✗✓ 0.93");
  });

  it("unsure renders a dim mark and takeaway", () => {
    const out = plain(
      formatChecks([
        check({ pass: true, judge: { secondJudge: sj({ choice: "pass", confidence: 0.31 }) } }),
      ]),
    );
    expect(out).toContain("·0.31");
    expect(out).toContain("Second judge unsure (0.31) — weak corroboration.");
  });

  it("error renders 2nd ✕ with the error text", () => {
    const out = plain(
      formatChecks([check({ judge: { secondJudge: sj({ error: "HTTP 429" }) } })]),
    );
    expect(out).toContain("2nd ✕");
    expect(out).toContain("Second opinion failed to arrive (HTTP 429).");
  });

  it("oversize input renders 2nd ⊘ and the skip takeaway, never 'failed to arrive'", () => {
    const out = plain(
      formatChecks([
        check({
          judge: {
            secondJudge: sj({
              skipped: "input ~97,000 tokens exceeds typesafe/jev-1.13's context limit",
            }),
          },
        }),
      ]),
    );
    expect(out).toContain("2nd ⊘");
    expect(out).toContain(
      "Second opinion skipped — input ~97,000 tokens exceeds typesafe/jev-1.13's context limit.",
    );
    expect(out).not.toContain("failed to arrive");
  });

  it("verbose marks a projected second-judge verdict", () => {
    const out = plain(
      formatChecks(
        [
          check({
            pass: true,
            judge: {
              secondJudge: sj({ choice: "pass", confidence: 0.98, projected: true }),
            },
          }),
        ],
        true,
      ),
    );
    expect(out).toContain("graded a projected value");
  });

  it("verbose adds the facts line", () => {
    const out = plain(
      formatChecks(
        [
          check({
            pass: true,
            judge: {
              secondJudge: sj({
                choice: "fail",
                confidence: 0.99,
                passProbability: 0.03,
                latencyMs: 588,
                costUsd: 0.000022,
              }),
            },
          }),
        ],
        true,
      ),
    );
    expect(out).toContain("2nd judge (typesafe/jev-1.13): FAIL · p(pass) 0.03 · conf 0.99 · 588ms · $0.000022");
  });
});

describe("secondJudgeSummary", () => {
  it("null when no second judge ran on any check", () => {
    expect(secondJudgeSummary([check(), check({ pass: false })])).toBeNull();
  });

  it("counts corroborated, split, and unsure", () => {
    const checks = [
      check({ id: "a", judge: { secondJudge: sj({ choice: "pass", confidence: 0.98 }) } }),
      check({ id: "b", pass: false, judge: { secondJudge: sj({ choice: "fail", confidence: 0.95 }) } }),
      check({ id: "c", pass: true, judge: { secondJudge: sj({ choice: "fail", confidence: 0.99 }) } }),
      check({ id: "d", judge: { secondJudge: sj({ choice: "pass", confidence: 0.31 }) } }),
    ];
    expect(secondJudgeSummary(checks)).toBe(
      "Second judge: 2 corroborated · judges split on 1 · 1 unsure",
    );
  });

  it("omits zero categories", () => {
    const checks = [
      check({ id: "a", judge: { secondJudge: sj({ choice: "pass", confidence: 0.98 }) } }),
    ];
    expect(secondJudgeSummary(checks)).toBe("Second judge: 1 corroborated");
  });

  it("counts skipped separately from judged checks", () => {
    const checks = [
      check({ id: "a", judge: { secondJudge: sj({ choice: "pass", confidence: 0.98 }) } }),
      check({ id: "b", judge: { secondJudge: sj({ skipped: "input ~97,000 tokens exceeds the limit" }) } }),
      check({ id: "c", judge: { secondJudge: sj({ skipped: "input ~97,000 tokens exceeds the limit" }) } }),
    ];
    expect(secondJudgeSummary(checks)).toBe(
      "Second judge: 1 corroborated · 2 skipped (value too large)",
    );
  });

  it("a run where every second opinion was skipped still gets the fact line", () => {
    const checks = [
      check({ id: "b", judge: { secondJudge: sj({ skipped: "input ~97,000 tokens exceeds the limit" }) } }),
    ];
    expect(secondJudgeSummary(checks)).toBe(
      "Second judge: 0 corroborated · 1 skipped (value too large)",
    );
  });
});
