/**
 * Recorder — collects assertion outcomes within a single check so every
 * failure is reported (nothing throws/dies on the first miss). Aggregated
 * per-check by the runner into one evaluation result.
 */

import type { AssertionResult, CheckLocation } from "../run/types.ts";

/** Back-compat alias; {@link AssertionResult} is the canonical type. */
export type AssertionRecord = AssertionResult;

/**
 * Optional hook the runner installs when it knows how to map a stack to the
 * task/check module. The Recorder captures ``new Error().stack`` at the
 * assertion call site and hands it to ``locate``.
 */
export type LocateFn = (stack: string) => CheckLocation | undefined;

export class Recorder {
  private records: AssertionResult[] = [];
  private readonly locate?: LocateFn;

  constructor(locate?: LocateFn) {
    this.locate = locate;
  }

  /**
   * Record an assertion.
   *
   * - ``extra.location`` overrides auto-capture (used by the runner for thrown
   *   errors, whose relevant stack is the error's own, not the call site).
   * - ``extra.expected`` / ``extra.received`` carry the structured values for
   *   testing-framework-style display.
   */
  /**
   * Capture the call site location synchronously. Use this when a record will
   * happen AFTER an `await` (e.g. `t.judge`): once an async function resumes,
   * `new Error().stack` reports the caller's frame at an unreliable line
   * (often the statement's closing brace). Capturing here, before the await,
   * pins the location to the actual call line; pass it to ``record`` via
   * ``extra.location``.
   */
  captureLocation(): CheckLocation | undefined {
    return this.locate ? this.locate(new Error().stack ?? "") : undefined;
  }

  record(
    id: string,
    pass: boolean,
    reasoning: string,
    extra?: {
      location?: CheckLocation;
      expected?: string;
      received?: unknown;
      evaluator_type?: "llm" | "code";
      judge?: import("../run/types.ts").JudgeMetadata;
      outcome?: import("../run/types.ts").AssertionOutcome;
    },
  ): void {
    const location =
      extra?.location
      ?? (this.locate ? this.locate(new Error().stack ?? "") : undefined);
    this.records.push({
      id,
      pass,
      reasoning,
      location,
      expected: extra?.expected,
      received: extra?.received,
      evaluator_type: extra?.evaluator_type,
      judge: extra?.judge,
      outcome: extra?.outcome,
    });
  }

  get all(): readonly AssertionResult[] {
    return this.records;
  }
}
