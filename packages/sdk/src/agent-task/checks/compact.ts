/**
 * Check submission compaction (issue #175).
 *
 * The backend's ``check_report_storage.normalize_check_report`` truncates
 * every ``received`` over 4 KiB and every judge prompt/response segment over
 * 16 KiB into a marker before storing anything — the full value never
 * survives server-side. This module applies the same limits at the producer,
 * so a task judging N criteria against one large document sends N tiny
 * markers instead of N copies of the document (a 43 MB result body becomes
 * single-digit MB). Local rendering keeps the uncompacted values.
 *
 * The markers are byte-compatible with the backend's (same field names,
 * preview length, and hash subject), so server-side normalization passes
 * them through unchanged and old servers store them as-is.
 */

import { createHash } from "node:crypto";

import type { AssertionResult, EvaluationItemResult, JudgeMetadata } from "../run/types.ts";

/** Mirrors backend RECEIVED_VALUE_LIMIT (check_report_storage.py). */
export const RECEIVED_VALUE_LIMIT = 4 * 1024;
/** Mirrors backend JUDGE_SEGMENT_LIMIT. */
export const JUDGE_SEGMENT_LIMIT = 16 * 1024;

const PREVIEW_CHARS = 256;

export interface CheckCompaction {
  /** Copy of ``checks`` with oversized fields replaced by markers. */
  checks: EvaluationItemResult[];
  /** How many ``received`` values were replaced. */
  truncatedValues: number;
  /** How many judge prompt/response segments were replaced. */
  truncatedSegments: number;
}

type TruncatedMarker = {
  kind: "truncated";
  preview: string;
  size_bytes: number;
  sha256: string;
};

/**
 * Return a submission-safe copy of ``checks``. Touched paths are copied;
 * untouched values are shared. Input is never mutated.
 */
export function compactChecksForSubmission(
  checks: readonly EvaluationItemResult[],
): CheckCompaction {
  let truncatedValues = 0;
  let truncatedSegments = 0;

  const compacted = checks.map((check) => {
    const next: Record<string, unknown> = { ...check };
    if ("received" in next && next.received !== undefined) {
      // Legacy top-level shape — mirrors _normalize_check.
      const replaced = truncateValue(next.received);
      if (replaced !== next.received) {
        next.received = replaced;
        truncatedValues += 1;
      }
    }
    if (next.judge !== undefined) {
      const { value, truncated } = truncateJudge(next.judge);
      if (value !== next.judge) {
        next.judge = value;
        truncatedSegments += truncated;
      }
    }
    const sourceAssertions = check.assertions;
    if (sourceAssertions) {
      const assertions = sourceAssertions.map((assertion) => {
        const nextAssertion: Record<string, unknown> = { ...assertion };
        if (nextAssertion.received !== undefined) {
          const replaced = truncateValue(nextAssertion.received);
          if (replaced !== nextAssertion.received) {
            nextAssertion.received = replaced;
            truncatedValues += 1;
          }
        }
        if (nextAssertion.judge !== undefined) {
          const { value, truncated } = truncateJudge(nextAssertion.judge);
          if (value !== nextAssertion.judge) {
            nextAssertion.judge = value;
            truncatedSegments += truncated;
          }
        }
        return nextAssertion as unknown as AssertionResult;
      });
      if (assertions.some((a, i) => a !== sourceAssertions[i])) {
        next.assertions = assertions;
      }
    }
    return next as unknown as EvaluationItemResult;
  });

  return { checks: compacted, truncatedValues, truncatedSegments };
}

/** Truncate a judge object's oversized segments; report how many were cut. */
function truncateJudge(judge: unknown): { value: JudgeMetadata; truncated: number } {
  if (typeof judge !== "object" || judge === null) {
    return { value: judge as JudgeMetadata, truncated: 0 };
  }
  let truncated = 0;
  const next: Record<string, unknown> = { ...judge };
  const prompt = next.prompt;
  if (typeof prompt === "object" && prompt !== null) {
    const nextPrompt: Record<string, unknown> = { ...prompt };
    for (const key of ["system", "user"] as const) {
      const value = nextPrompt[key];
      if (typeof value === "string") {
        const replaced = truncateText(value);
        if (replaced !== value) {
          nextPrompt[key] = replaced;
          truncated += 1;
        }
      }
    }
    next.prompt = nextPrompt;
  }
  if (typeof next.response === "string") {
    const replaced = truncateText(next.response);
    if (replaced !== next.response) {
      next.response = replaced;
      truncated += 1;
    }
  }
  const session = next.session;
  if (typeof session === "object" && session !== null) {
    truncated += truncateSessionText(session as Record<string, unknown>);
    // session is truncated in place: its steps/briefing are its own arrays.
  }
  return { value: next as unknown as JudgeMetadata, truncated };
}

/**
 * Truncate a structured ``received`` value when its compact JSON exceeds the
 * limit — the same subject the backend hashes (compact JSON bytes).
 */
function truncateValue(value: unknown): unknown {
  if (value === undefined) return value;
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value));
  } catch {
    bytes = new TextEncoder().encode(JSON.stringify(String(value)));
  }
  if (bytes.length <= RECEIVED_VALUE_LIMIT) return value;
  return marker(bytes);
}

/** Truncate a judge text segment over the raw UTF-8 bytes of the string. */
function truncateText(value: string): TruncatedMarker | string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= JUDGE_SEGMENT_LIMIT) return value;
  return marker(bytes);
}

/** The backend's TruncatedCheckValue marker, computed over the same bytes. */
function marker(bytes: Uint8Array): TruncatedMarker {
  const previewBytes = bytes.slice(0, PREVIEW_CHARS);
  // Node's UTF-8 decoder replaces truncated sequences with U+FFFD, matching
  // the backend's errors="replace".
  const preview = Buffer.from(previewBytes).toString("utf8");
  return {
    kind: "truncated",
    preview,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Defensive pass over an agentic session's text fields (briefing, step text,
 * tool input/result). The engine already truncates at record time; this
 * mirrors the backend's normalize step so a hand-built session can never
 * blow the submission budget. sha256/bytes identity fields are never touched.
 */
function truncateSessionText(session: Record<string, unknown>): number {
  let truncated = 0;
  const briefing = session.briefing;
  if (typeof briefing === "object" && briefing !== null) {
    for (const key of ["system", "rubric"] as const) {
      const value = (briefing as Record<string, unknown>)[key];
      if (typeof value === "string") {
        const replaced = truncateText(value);
        if (replaced !== value) {
          (briefing as Record<string, unknown>)[key] = replaced;
          truncated += 1;
        }
      }
    }
  }
  const steps = session.steps;
  if (Array.isArray(steps)) {
    session.steps = steps.slice(0, 64).map((step) => {
      if (typeof step !== "object" || step === null) return step;
      const next: Record<string, unknown> = { ...step };
      if (typeof next.text === "string") {
        const replaced = truncateText(next.text);
        if (replaced !== next.text) {
          next.text = replaced;
          truncated += 1;
        }
      }
      if (Array.isArray(next.tool_calls)) {
        next.tool_calls = (next.tool_calls as Record<string, unknown>[]).map((call) => {
          const nextCall = { ...call };
          for (const key of ["input", "result"] as const) {
            const value = nextCall[key];
            if (typeof value === "string") {
              const replaced = truncateText(value);
              if (replaced !== value) {
                nextCall[key] = replaced;
                truncated += 1;
              }
            }
          }
          return nextCall;
        });
      }
      return next;
    });
  }
  return truncated;
}
