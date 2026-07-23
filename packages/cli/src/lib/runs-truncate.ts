/**
 * Issue #22: a run stores the full deliverable value per check (assertion
 * `received`, judge `prompt`/`response`) and the full deliverables payload.
 * For large deliverables that repeats tens of KB across every criterion,
 * making `runs show` huge and unreadable. These helpers preview large values
 * to a short string + a `--full` hint, leaving small values and their types
 * untouched. The dashboard keeps the full structured value; this is a
 * CLI/summary projection only.
 */

import type {
  CheckAssertionResult,
  CheckJudgeMetadata,
  CheckResult,
} from "./agent-task-types.ts";

/** Max chars shown verbatim before a value is replaced by a one-line manifest.
 * Below this, code-diff scalars and short prose stay inline (they're the useful
 * `− Expected / + Received` diff). Above it, the value is almost certainly a
 * deliverable body — previewing it adds noise without explaining the failure
 * (that's what `reasoning` is for), so it's omitted with a fetch hint. */
export const RECEIVED_PREVIEW_CHARS = 500;
export const DELIVERABLE_PREVIEW_CHARS = 500;

/**
 * Replace a large string with a one-line manifest: no content, just the total
 * length and the `--full` flag. Short strings are returned unchanged.
 */
export function previewString(str: string, threshold: number): string {
  if (str.length <= threshold) return str;
  return manifestFor(str.length);
}

/** `⟨20,000 chars — use --full⟩` — the manifest line for an omitted value. */
export function manifestFor(length: number): string {
  return `⟨${length.toLocaleString()} chars — use --full⟩`;
}

/**
 * Preview any value when it is large. Strings are previewed directly; other
 * values are serialized and, if large, replaced by a preview string. Small
 * values are returned as-is (type preserved), so a tiny structured deliverable
 * stays structured. `full=true` short-circuits to the original value.
 */
export function truncateValue(value: unknown, maxChars: number, full: boolean): unknown {
  if (full || value == null) return value;
  const str = typeof value === "string" ? value : safeStringify(value);
  if (str.length <= maxChars) return value;
  return previewString(str, maxChars);
}

/**
 * Build a concise copy of a run's checks: every assertion's `received` and
 * every judge `prompt`/`response` is previewed when large. The useful, small
 * fields (`id`, `pass`, `reasoning`, `expected`, `instruction`) are never
 * touched. The input array is not mutated.
 */
export function conciseChecks(checks: CheckResult[] | null, full: boolean): CheckResult[] | null {
  if (full || !checks) return checks;
  return checks.map((c) => ({
    ...c,
    judge: c.judge ? conciseJudge(c.judge) : c.judge,
    assertions: c.assertions?.map((a) => conciseAssertion(a)),
  }));
}

/**
 * Preview each deliverable value. The deliverable *names* (keys) are always
 * kept; only large values are previewed, so the run still shows what was
 * produced. Input is not mutated.
 */
export function conciseDeliverables(
  deliverables: Record<string, unknown> | null,
  full: boolean,
): Record<string, unknown> | null {
  if (full || !deliverables) return deliverables;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(deliverables)) {
    out[key] = truncateValue(value, DELIVERABLE_PREVIEW_CHARS, false);
  }
  return out;
}

function conciseAssertion(a: CheckAssertionResult): CheckAssertionResult {
  return {
    ...a,
    received: truncateValue(a.received, RECEIVED_PREVIEW_CHARS, false),
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
