/**
 * Recorder — collects assertion outcomes within a single check so every
 * failure is reported (nothing throws/dies on the first miss). Aggregated
 * per-check by the runner into one evaluation result.
 */

import type { AssertionResult, CheckLocation } from "../run/types.ts";

/**
 * Optional hook the runner installs when it knows how to map a stack to the
 * task/check module. The Recorder captures ``new Error().stack`` at the
 * assertion call site and hands it to ``locate``.
 */
export type LocateFn = (stack: string) => CheckLocation | undefined;

export class Recorder {
  private records: AssertionResult[] = [];
  private readonly locate?: LocateFn;
  private pending: Promise<unknown>[] = [];

  constructor(locate?: LocateFn) {
    this.locate = locate;
  }

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

  /**
   * Register an async evaluation (``t.judge`` / ``t.agent``) started by this
   * check. If the check returns without awaiting it, the runner still waits
   * for its record via ``settlePending`` — a dropped await must not let the
   * check vacuously pass ("no assertions recorded") while the verdict is
   * still in flight.
   */
  track(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  /** Wait until every tracked evaluation has settled (and recorded). */
  async settlePending(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  /**
   * Record an assertion.
   *
   * - ``extra.location`` overrides auto-capture (used by the runner for thrown
   *   errors, whose relevant stack is the error's own, not the call site).
   * - ``extra.expected`` / ``extra.received`` carry the structured values for
   *   testing-framework-style display.
   */
  record(
    id: string,
    pass: boolean,
    reasoning: string,
    extra?: {
      location?: CheckLocation;
      expected?: string;
      received?: unknown;
      evaluator_type?: "llm" | "code" | "agent";
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
