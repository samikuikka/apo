/**
 * Merge server-fetched trace calls with live-streamed ones.
 *
 * The SSR snapshot (`baseCalls`) carries rich data (input/output/metadata),
 * while the SSE stream (`streamCalls`) carries sparse incremental updates
 * and brand-new spans the snapshot didn't include. We must not let the
 * sparse stream data clobber rich fields: a `span:updated` replay only
 * sends a subset of fields and would null out input/output if naively
 * spread over the SSR call.
 *
 * Rules:
 *  - Start from the base calls (by id) so the rich snapshot is preserved.
 *  - For an existing id, overlay only the stream fields that are present
 *    and non-null (e.g. latency_ms, cost, output once a span ends).
 *  - For a new id, add the streamed call as-is (it may be sparse, but the
 *    tree/gantt only need id/parent/timing/model to render structure).
 */

import type { LoggedCall } from "./contexts/TraceDataContext";

/**
 * Fields that, when present on a streamed update, should overwrite the base
 * call. Anything not in this set is ignored on overlay to protect rich data.
 */
const MERGEABLE_FIELDS = [
  "latency_ms",
  "cost",
  "total_tokens",
  "prompt_tokens",
  "completion_tokens",
  "time_to_first_token_ms",
  "status_message",
  "level",
  "output",
  "end_time",
  "metadata",
] as const;

export function mergeLiveCalls(
  baseCalls: LoggedCall[],
  streamCalls: LoggedCall[],
): LoggedCall[] {
  if (streamCalls.length === 0) return baseCalls;

  const merged = new Map<string, LoggedCall>(baseCalls.map((c) => [c.id, c]));

  for (const streamed of streamCalls) {
    const existing = merged.get(streamed.id);
    if (!existing) {
      merged.set(streamed.id, streamed);
      continue;
    }
    // Field-merge: only copy through known update fields that are present.
    let updated = false;
    const next: LoggedCall = existing;
    for (const field of MERGEABLE_FIELDS) {
      const value = streamed[field] as LoggedCall[typeof field];
      if (value != null) {
        // Build a new object lazily so we don't clone when nothing changed.
        if (!updated) {
          merged.set(streamed.id, { ...next });
          updated = true;
        }
        (merged.get(streamed.id) as LoggedCall)[field] = value;
      }
    }
  }

  return [...merged.values()];
}
