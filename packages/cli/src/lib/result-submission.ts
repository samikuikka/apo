/**
 * Shared result-submission size accounting (issue #249).
 *
 * Result bodies are a negotiated contract: the server advertises
 * ``result_max_bytes`` at claim/create time and its request-size middleware
 * enforces it with HTTP 413. This module owns the client side of that
 * contract — parsing the advertised limit, measuring the exact UTF-8 bytes
 * of the final serialized body, and the typed error that distinguishes a
 * definite rejection (413) from an ambiguous transport failure.
 *
 * Measurements carry byte counts and field names only — never field
 * contents, credentials, or judged subject text.
 */

/** Mirrors the backend's shipped APO_RESULT_MAX_BODY_BYTES default (10 MiB). */
export const DEFAULT_RESULT_MAX_BYTES = 10_485_760;

export interface ResultBodySize {
  totalBytes: number;
  limitBytes: number;
  /** Top-level serialized value bytes; explanatory, not required to sum to total. */
  fields: Record<string, number>;
}

/**
 * A non-ok /result response, carrying the HTTP status so callers can tell a
 * definite rejection (413) from an ambiguous transport failure. The detail
 * is a bounded excerpt of the response — the request body is never included.
 */
export class ResultSubmissionHttpError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`result submission failed: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "ResultSubmissionHttpError";
    this.status = status;
  }
}

/** Bounded response excerpt for diagnostics; never the request body. */
export async function boundedResponseDetail(resp: Response, maxChars = 300): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  } catch {
    return "";
  }
}

/**
 * Parse a server-advertised result limit. Missing (an older caller server)
 * falls back to the documented default; malformed values (zero, negative,
 * fractional, NaN) are protocol errors — never silently "unlimited".
 */
export function parseAdvertisedResultMaxBytes(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_RESULT_MAX_BYTES;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new Error(`server advertised an invalid result_max_bytes (${JSON.stringify(raw)})`);
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`server advertised an invalid result_max_bytes (${JSON.stringify(raw)})`);
  }
  return value;
}

export interface PreparedResultSubmission {
  /** The exact body to send — measure and submit the same bytes. */
  serialized: string;
  size: ResultBodySize;
  /** True when the serialized body is strictly over the advertised limit. */
  overLimit: boolean;
}

/**
 * Serialize the final result body once and measure its exact UTF-8 bytes
 * against the advertised limit. Field counts are explanatory values for
 * diagnostics; keys and separators mean they need not sum to the total.
 */
export function prepareResultSubmission(body: unknown, limitBytes: number): PreparedResultSubmission {
  const serialized = JSON.stringify(body) ?? "null";
  const totalBytes = Buffer.byteLength(serialized, "utf8");
  const fields: Record<string, number> = {};
  if (body !== null && typeof body === "object") {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      fields[key] = Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
    }
  }
  return {
    serialized,
    size: { totalBytes, limitBytes, fields },
    overLimit: totalBytes > limitBytes,
  };
}

/**
 * The bounded ``result_too_large:`` diagnostic recorded on the failure
 * endpoint: total bytes, the advertised limit, and the largest top-level
 * field sizes. Byte counts and field names only — no field contents.
 */
export function formatResultTooLarge(size: ResultBodySize): string {
  const largest = Object.entries(size.fields)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, bytes]) => `${key}=${bytes}`)
    .join(", ");
  return (
    `result_too_large: total_bytes=${size.totalBytes} limit_bytes=${size.limitBytes}` +
    (largest ? ` largest_fields=${largest}` : "")
  );
}
