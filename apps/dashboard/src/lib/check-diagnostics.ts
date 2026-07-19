import type { CheckAssertionResult, CheckResult } from "@/lib/agent-task-api";
import { locateAssertionInBlock, locateAssertionsInBlock } from "./locate-assertion";
import { extractJudgeReasoning } from "./judge-reasoning";

export type CheckDiagnostic = {
  line: number;
  column?: number;
  message: string;
  severity: "error" | "info";
};

/**
 * Extended diagnostic that also carries structured expected/received so the
 * dashboard can render a Jest-style "− Expected / + Received" tooltip rather
 * than a flat one-liner. When the values are short or absent, callers fall
 * back to the plain {@link CheckDiagnostic.message} string.
 */
export type RichCheckDiagnostic = CheckDiagnostic & {
  /** Assertion label, shown as the tooltip title (e.g. `maxToolCalls(40)`). */
  label: string;
  /** Structured "expected" value — rendered with `−` marker, green tinted. */
  expected?: string;
  /** Structured "received" value — rendered with `+` marker, red tinted. */
  received?: string;
  /** LLM judge reasoning — rendered as prose body when present. */
  reasoning?: string;
  /** "llm" for judge assertions (verdict presentation), "code" otherwise. */
  evaluator_type?: "llm" | "code";
};

/**
 * Format the hover message for an assertion.
 *
 * Priority for failures:
 *   1. LLM judge reasoning — the judge's prose IS the diagnostic answer.
 *   2. expected/received pair — for t.check() failures with structured values.
 *   3. plain reasoning — for assertions with prose but no structured values.
 *   4. assertion id — last-resort label.
 *
 * Passes always read "passed" — green gutters are for visual scan, not deep
 * content. Use the failure's hover if you want the details.
 */
function formatAssertionMessage(assertion: CheckAssertionResult): string {
  if (assertion.pass) return "passed";
  if (assertion.judge && assertion.reasoning) {
    return assertion.reasoning;
  }
  if (assertion.expected != null || assertion.received != null) {
    const expected = assertion.expected ?? "—";
    const received = assertion.received ?? "—";
    return `expected ${expected} · received ${received}`;
  }
  return assertion.reasoning || assertion.id;
}

/**
 * Decide whether an assertion earns a gutter marker.
 *
 * All assertions get a marker — passes (green) and failures (red). Showing
 * passes lets users click a green marker to see the actual values (e.g.
 * "received: 6" for maxToolCalls), the same way they click red markers to
 * see why something failed.
 */
function shouldShowMarker(_assertion: CheckAssertionResult): boolean {
  return true;
}

/**
 * Should the renderer show the "− Expected / + Received" diff for this
 * diagnostic? The diff is a FAILURE presentation — a passing judge carries
 * expected/received data too, but diffing it makes a pass look like a mistake.
 * Show the diff only for failures (error severity).
 */
export function shouldShowDiff(diag: { severity?: "error" | "info" | "warning" }): boolean {
  return diag.severity === "error";
}

/**
 * Is this a judge (LLM) assertion? Judges get a verdict+rubric presentation
 * (the reasoning IS the answer; the rubric is context) and never a value-diff
 * — the evaluated values are huge/noisy and live in Deliverables/JSON.
 */
export function isJudgeDiagnostic(diag: { evaluator_type?: "llm" | "code" }): boolean {
  return diag.evaluator_type === "llm";
}

export function buildCheckDiagnostics(
  item: CheckResult,
  startLine: number,
  endLine: number,
  blockCode?: string,
): RichCheckDiagnostic[] {
  // For each marker-worthy assertion, resolve an ABSOLUTE source line.
  // Primary: re-derive from the current source (`blockCode`) by matching the
  // assertion's method + argument — robust to file edits and to V8's stack
  // line quirks on multi-line/async calls (which used to put markers on
  // comments / closing braces). Fallback: the recorder's stored location.
  const markerAssertions = (item.assertions ?? []).filter(shouldShowMarker);

  // Resolve lines using the batch locator so multiple same-method assertions
  // (e.g. two t.judge() calls) each get their OWN line.
  const batchLines = blockCode
    ? locateAssertionsInBlock(
        blockCode,
        markerAssertions.map((a) => ({ id: a.id })),
      )
    : undefined;

  const located = markerAssertions.map((assertion, i) => {
    let absLine = assertion.location?.line;
    if (batchLines && batchLines[i] !== undefined) {
      absLine = startLine + batchLines[i]! - 1;
    } else if (blockCode) {
      const localLine = locateAssertionInBlock(blockCode, assertion.id);
      if (localLine !== undefined) absLine = startLine + localLine - 1;
    }
    return {
      absLine,
      message: formatAssertionMessage(assertion),
      pass: assertion.pass,
      assertion,
    };
  });

  const inRange = located.filter(
    (l) => l.absLine !== undefined && l.absLine >= startLine && l.absLine <= endLine,
  );

  // If no per-assertion line resolved, fall back to a single check-level
  // marker (historical results that only carry the check's own location).
  const locations = inRange.length > 0
    ? inRange
    : item.location && !item.pass
      ? [{
          absLine: item.location.line,
          message: item.reasoning || `Check "${item.id}" failed`,
          pass: false,
          assertion: undefined,
        }]
      : [];

  return locations.flatMap(({ absLine, message, pass, assertion }) => {
    if (absLine === undefined || absLine < startLine || absLine > endLine) return [];
    return [{
      line: absLine - startLine + 1,
      column: assertion?.location?.column,
      message,
      severity: pass ? ("info" as const) : ("error" as const),
      label: assertion?.id ?? item.id,
      expected: assertion?.expected,
      // The diff tooltip is code-assertion-only (judges early-return before
      // rendering it), where received is always a string scalar. Coerce the
      // polymorphic field to string just in case a structured value slips in.
      received: typeof assertion?.received === "string"
        ? assertion.received
        : assertion?.received != null ? JSON.stringify(assertion.received) : undefined,
      // Prefer the parsed reasoning; fall back to pulling it out of the raw
      // judge response (some runs leave assertion.reasoning empty even though
      // the model explained itself).
      reasoning:
        assertion?.reasoning?.trim()
        || (assertion?.judge ? extractJudgeReasoning(assertion.judge) : undefined),
      evaluator_type: assertion?.evaluator_type === "llm" ? "llm" : "code",
    }];
  });
}