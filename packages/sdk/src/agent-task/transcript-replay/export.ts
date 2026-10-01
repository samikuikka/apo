/**
 * OTLP export for replayed transcripts.
 *
 * Posts an OTLP/JSON traces payload to apo's public OTLP endpoint using the
 * same auth the live exporters use. Auth mode decides what the trace becomes:
 *
 * - API key (CLI import): the trace lands as an unclaimed project run.
 * - Attempt/service token (adapter capture): the replayed spans join the live
 *   task run's trace — the runner's root span already carries the claim.
 *
 * 5xx, 429, and network failures are retried — apo's admission controller
 * 429s OTLP ingest under per-key concurrency pressure, which the runner's own
 * simple-processor exports can create while a replay POST is in flight. Any
 * other 4xx is a caller bug (bad token, malformed payload) and fails fast
 * with the response body excerpt.
 */

import type { OtlpTracesPayload } from "./otlp.ts";

export class TranscriptReplayError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TranscriptReplayError";
    this.status = status;
  }
}

export type ExportOtlpTracesOptions = {
  /** apo base URL (e.g. http://localhost:8000); a full …/v1/traces URL is accepted verbatim. */
  endpoint: string;
  /** Attempt/service token — sent as the OTLP Authorization bearer. */
  token?: string;
  /** Complete headers override (e.g. buildApoAuthHeaders() for Basic API-key auth). */
  headers?: Record<string, string>;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /** Extra attempts after the first on 5xx/network failure. Default 2. */
  retries?: number;
};

/** Normalize an apo base URL into the public OTLP traces endpoint. */
export function resolveOtlpTracesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/traces")) return trimmed;
  return `${trimmed}/api/public/otel/v1/traces`;
}

export async function exportOtlpTraces(
  payload: OtlpTracesPayload,
  options: ExportOtlpTracesOptions,
): Promise<void> {
  const url = resolveOtlpTracesUrl(options.endpoint);
  const body = JSON.stringify(payload);
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const authHeaders =
    options.headers ??
    (options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : undefined);
  if (authHeaders === undefined) {
    throw new TranscriptReplayError("OTLP export requires a token or auth headers");
  }

  let lastFailure = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return;
      const text = await response.text().catch(() => "");
      if (response.status === 429 || response.status >= 500) {
        lastFailure = `HTTP ${response.status}: ${excerpt(text)}`;
        continue;
      }
      throw new TranscriptReplayError(
        `OTLP export rejected: HTTP ${response.status}: ${excerpt(text)} (${url})`,
        response.status,
      );
    } catch (error) {
      if (error instanceof TranscriptReplayError) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new TranscriptReplayError(
    `OTLP export failed after ${retries + 1} attempt(s): ${lastFailure} (${url})`,
  );
}

function excerpt(body: string): string {
  const flattened = body.replace(/\s+/g, " ").trim();
  return flattened.slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
