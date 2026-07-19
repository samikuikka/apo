import type { TestContext } from "@apo/sdk/agent-task";

// Anti-flail ceilings shared by every task's trajectory check.
// These are loose safety bounds — the task's own `maxTurns` config is what
// actually caps the run; these catch a runaway agent that ignores it.
export const MAX_TURNS = 10;
export const MAX_DURATION_MS = 5 * 60 * 1000;
export const MAX_TOOL_CALLS = 40;

// Destructive tools that a read-only analysis agent must never invoke.
export const DESTRUCTIVE_TOOLS = /^(write_file|delete_file|edit)$/;

/**
 * An objective fact the agent's output must contain.
 *
 * `pattern` is tested against the joined findings text (the deliverable's
 * `result.findings` array, concatenated). Use this for verifiable facts —
 * invoice totals, file names, function names, error codes — where there is
 * a single correct answer. Reserve `t.judge` for the subjective dimensions
 * (grounding, specificity, reasoning quality).
 */
export type ExpectedFact = {
  /** Short label shown in the assertion breakdown, e.g. "invoice total". */
  label: string;
  /** Pattern the joined findings must match. */
  pattern: RegExp;
};

/**
 * Assert every expected fact appears somewhere in the agent's findings.
 *
 * This is the **deterministic anchor** layer of an agent test suite: fast,
 * objective, reproducible checks that pin down *what* the agent produced.
 * They catch two things LLM judges are weak at — hallucinated answers that
 * sound right, and shallow answers that miss specific facts. They do NOT
 * replace judges; they complement them by removing the "plausible but wrong"
 * failure mode so judges can focus on quality.
 */
export function assertFacts(
  t: TestContext,
  findingsText: string,
  expected: ReadonlyArray<ExpectedFact>,
): void {
  for (const fact of expected) {
    t.check(
      findingsText,
      {
        label: `findings include ${fact.label}`,
        test: (v) => fact.pattern.test(v),
      },
      `expected finding: ${fact.label}`,
    );
  }
}

/**
 * Join the findings array into a single string for pattern matching.
 * Findings are `string[]` — the agent's structured deliverable.
 */
export function joinFindings(findings: unknown): string {
  if (!Array.isArray(findings)) return "";
  return findings.filter((f): f is string => typeof f === "string").join("\n");
}
