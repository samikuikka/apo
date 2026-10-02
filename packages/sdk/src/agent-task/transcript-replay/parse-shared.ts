/**
 * Shared low-level helpers for session-transcript parsers.
 *
 * Parsers are pure functions over the file content: no filesystem access, no
 * mutable state outside the call. That purity is what lets the adapter
 * capture path, the CLI import path, and a future incremental watch mode
 * share one implementation.
 */

export type JsonObject = Record<string, unknown>;

/** Split JSONL content into parsed objects; unparseable lines become warnings. */
export function parseTranscriptLines(
  content: string,
  warnings: string[],
): JsonObject[] {
  const events: JsonObject[] = [];
  let torn = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) events.push(parsed);
      else torn++;
    } catch {
      // Harnesses append to the transcript as they run, so the last line can
      // be a torn write. One bad line must never fail the whole file.
      torn++;
    }
  }
  if (torn > 0) {
    warnings.push(`skipped ${torn} unparseable line(s) (torn or partial writes)`);
  }
  return events;
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Parse a string that may hold JSON; returns undefined when not valid JSON. */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Later of two ISO timestamps by wall-clock value (undefined-safe). */
export function laterTimestamp(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

/** Sum two usage records field-wise; absent fields count as zero. */
export function sumUsage<T extends {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}>(total: T | undefined, add: T): T {
  if (total === undefined) return add;
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    ...total,
    inputTokens: sum(total.inputTokens, add.inputTokens),
    outputTokens: sum(total.outputTokens, add.outputTokens),
    cacheReadTokens: sum(total.cacheReadTokens, add.cacheReadTokens),
    cacheWriteTokens: sum(total.cacheWriteTokens, add.cacheWriteTokens),
    reasoningTokens: sum(total.reasoningTokens, add.reasoningTokens),
  };
}
