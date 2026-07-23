/**
 * Issue #22: a run stores the full deliverable value per check (assertion
 * `received`, judge `prompt`/`response`) and the full deliverables payload.
 * For large deliverables that repeats tens of KB across every criterion,
 * making `runs show` huge and unreadable. These helpers replace any large
 * value with a one-line manifest pointing at `apo runs deliverable`, which
 * fetches a deliverable's content ONCE (not per-check). The dashboard keeps
 * the full structured value; this is a CLI/summary projection only.
 */

import type {
  CheckAssertionResult,
  CheckJudgeMetadata,
  CheckResult,
} from "./agent-task-types.ts";

/** Max chars shown verbatim before a value is replaced by a manifest. Below
 * this, code-diff scalars and short prose stay inline (the useful
 * `− Expected / + Received` diff). Above it, the value is almost certainly a
 * deliverable body, so it's omitted with a fetch hint. */
export const RECEIVED_PREVIEW_CHARS = 500;
export const DELIVERABLE_PREVIEW_CHARS = 500;

/** Hint pointing at the command that reads full content without re-dumping
 * every check. Kept in one place so the manifest stays accurate. */
const FETCH_HINT = "apo runs deliverable";

/**
 * The manifest line for an omitted value: no content, just the total length
 * and the command that fetches it.
 */
export function manifestFor(length: number): string {
  return `⟨${length.toLocaleString()} chars — ${FETCH_HINT}⟩`;
}

/**
 * Replace a large string with its manifest. Short strings are returned
 * unchanged.
 */
export function previewString(str: string, threshold: number): string {
  return str.length <= threshold ? str : manifestFor(str.length);
}

/**
 * Preview any value when it is large. Strings are previewed directly; other
 * values are serialized and, if large, replaced by the manifest. Small values
 * are returned as-is (type preserved), so a tiny structured deliverable stays
 * structured.
 */
export function truncateValue(value: unknown, threshold: number): unknown {
  if (value == null) return value;
  const str = typeof value === "string" ? value : safeStringify(value);
  if (str.length <= threshold) return value;
  return manifestFor(str.length);
}

/**
 * Build a concise copy of a run's checks: every assertion's `received` and
 * every judge `prompt`/`response` is manifest-only when large. The useful,
 * small fields (`id`, `pass`, `reasoning`, `expected`, `instruction`) are
 * never touched. The input array is not mutated.
 */
export function conciseChecks(checks: CheckResult[] | null): CheckResult[] | null {
  if (!checks) return checks;
  return checks.map((c) => ({
    ...c,
    judge: c.judge ? conciseJudge(c.judge) : c.judge,
    assertions: c.assertions?.map((a) => conciseAssertion(a)),
  }));
}

/**
 * Manifest each deliverable value. The deliverable *names* (keys) are always
 * kept; only large values are omitted, so the run still shows what was
 * produced. Input is not mutated.
 */
export function conciseDeliverables(
  deliverables: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!deliverables) return deliverables;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(deliverables)) {
    out[key] = truncateValue(value, DELIVERABLE_PREVIEW_CHARS);
  }
  return out;
}

function conciseAssertion(a: CheckAssertionResult): CheckAssertionResult {
  return {
    ...a,
    received: truncateValue(a.received, RECEIVED_PREVIEW_CHARS),
    judge: a.judge ? conciseJudge(a.judge) : a.judge,
  };
}

function conciseJudge(j: CheckJudgeMetadata): CheckJudgeMetadata {
  const prompt = j.prompt
    ? {
        system: truncateStr(j.prompt.system),
        user: truncateStr(j.prompt.user),
      }
    : j.prompt;
  return {
    ...j,
    prompt,
    response: truncateStr(j.response),
  };
}

function truncateStr(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return previewString(s, RECEIVED_PREVIEW_CHARS);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
