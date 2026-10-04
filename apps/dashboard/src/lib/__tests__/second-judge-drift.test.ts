import { describe, expect, it } from "vitest";
import {
  secondJudgeFacts as dashFacts,
  secondJudgeTakeaway as dashTakeaway,
} from "../second-judge";
// Test-time-only import — vitest resolves the workspace pkg; this never enters
// the browser bundle. The SDK is the single source of truth; the dashboard
// keeps a local copy (see second-judge.ts) only to avoid bundling the SDK's
// server runtime. These assertions are the drift guard.
import {
  secondJudgeFacts as sdkFacts,
  secondJudgeTakeaway as sdkTakeaway,
} from "@apo-ai/sdk/agent-task";
import type { CheckResult } from "../agent-task-api";

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return { id: "c-1", pass: true, reasoning: "", ...overrides } as CheckResult;
}

function withSj(evidence: Record<string, unknown>): CheckResult {
  return check({
    pass: false,
    judge: {
      model: "primary",
      secondJudge: { model: "typesafe/jev-1.13", ...evidence },
    } as CheckResult["judge"],
  });
}

/**
 * A fixture per reachable facts kind, plus the boundary cases around the
 * split predicate (choice vs pass in both directions) and the 0.6 unsure
 * threshold. Local and SDK derivations must agree on every one.
 */
const FACT_FIXTURES: Array<[string, CheckResult]> = [
  ["no evidence → none", check()],
  ["error evidence → error", withSj({ error: "HTTP 429" })],
  ["choice missing → error", withSj({ confidence: 0.9 })],
  ["skipped evidence → skipped", withSj({ skipped: "context exceeded" })],
  ["verdicts differ → split", withSj({ choice: "pass", confidence: 0.99 })],
  ["verdicts agree weakly → unsure", withSj({ choice: "fail", confidence: 0.31 })],
  ["verdicts agree at boundary → unsure", withSj({ choice: "fail", confidence: 0.59 })],
  ["verdicts agree strongly → agree", withSj({ choice: "fail", confidence: 0.98 })],
  [
    "passing check the second judge fails → split",
    check({
      pass: true,
      judge: { model: "m", secondJudge: { model: "x", choice: "fail", confidence: 0.8 } } as CheckResult["judge"],
    }),
  ],
  [
    "missing confidence defaults to 0 → unsure",
    withSj({ choice: "fail" }),
  ],
];

describe("second-judge derivations (drift guard)", () => {
  for (const [name, fixture] of FACT_FIXTURES) {
    it(`facts agree with the SDK: ${name}`, () => {
      expect(dashFacts(fixture)).toEqual(sdkFacts(fixture));
    });
  }

  for (const [name, fixture] of FACT_FIXTURES) {
    it(`takeaway agrees with the SDK: ${name}`, () => {
      expect(dashTakeaway(fixture)).toBe(sdkTakeaway(fixture));
    });
  }
});
