import type { JsonValue, LangfuseObservation } from "./langfuse-otlp.ts";

export interface LangfuseConnectorConfig {
  host: string;
  publicKey: string;
  secretKey: string;
  maxObservations: number;
}

export interface LangfuseTraceGraph {
  sourceHost: string;
  sourceTraceId: string;
  observations: readonly LangfuseObservation[];
  trace?: {
    sessionId?: string | null;
    userId?: string | null;
  };
}

export class LangfuseEmptyTraceError extends Error {
  readonly sourceTraceId: string;
  constructor(sourceTraceId: string, message: string) {
    super(message);
    this.name = "LangfuseEmptyTraceError";
    this.sourceTraceId = sourceTraceId;
  }
}

export interface LangfusePollTiming {
  initialIntervalMs: number;
  maxIntervalMs: number;
  backoffFactor: number;
}

export interface LangfusePollOptions extends LangfusePollTiming {
  totalDeadlineMs: number;
  /**
   * Wall-clock quiet period (ms) the observation count must hold before the
   * trace is treated as ingested. Langfuse ingests asynchronously after the
   * root span, so "at least one observation" is not enough — but neither is a
   * count of consecutive polls (the previous rule), because a batch-flushing
   * tracer makes the count plateau *mid-ingest*. Wall-clock is the honest unit:
   * poll jitter can't shorten the window.
   */
  settleMs?: number;
  /**
   * Interval between stability polls (ms), used once the trace first appears.
   * Shorter than the existence-phase backoff so convergence is detected fast.
   */
  stabilityIntervalMs?: number;
  /**
   * The span in the target apo trace that the imported subtree hangs under
   * (--parent-span-id). When the agent runtime runs under a propagated
   * traceparent, its root observations legitimately point at this span, which is
   * outside the fetched set. Supplying it is what makes {@link
   * findPartialFetchReason} able to tell an expected external parent from a
   * parent that simply has not been ingested.
   */
  externalParentSpanId?: string;
  /**
   * Merge mode (--trace-id). Without an `externalParentSpanId` anchor, dangling
   * parents can't be judged in merge mode, so the structural gate stands down.
   */
  mergeMode?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Result of a poll-backed fetch. `notices` carries non-fatal warnings the
 * caller should surface (e.g., the trace hadn't fully stabilized when --wait
 * expired, so the import may be partial).
 */
export interface LangfuseFetchResult {
  graph: LangfuseTraceGraph;
  notices: string[];
}

// Injectable clock/sleep for detail hydration backoff (issue #28). Defaults to
// Date.now/setTimeout in production; tests pass deterministic stubs.
export interface HydrationOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_LANGFUSE_POLL_TIMING: LangfusePollTiming = {
  initialIntervalMs: 2_000,
  maxIntervalMs: 15_000,
  backoffFactor: 1.5,
};

// Stability defaults (issue #39): after the first observation appears, poll the
// count until it stops growing. The count plateauing is a weak signal — an
// agent runtime that flushes its tracer in batches plateaus for tens of seconds
// mid-ingest, and Langfuse Cloud's read API trails the ingest queue on top of
// that. A 4s window silently truncated real traces to ~55% of their spans, so
// the quiet period is wall-clock and generous; `findPartialFetchReason` is the
// signal that actually catches a partial fetch.
export const DEFAULT_SETTLE_MS = 15_000;
export const DEFAULT_STABILITY_INTERVAL_MS = 2_000;

export const DEFAULT_MAX_OBSERVATIONS = 10_000;
const MIN_MAX_OBSERVATIONS = 1;
const MAX_MAX_OBSERVATIONS = 50_000;
const PAGE_LIMIT = 1000;
const PAGE_TIMEOUT_MS = 15_000;
const DETAIL_TIMEOUT_MS = 15_000;
// Per-id detail requests run concurrently but capped — N+1 requests against
// Langfuse, bounded by --max-observations and this pool size.
const DETAIL_CONCURRENCY = 6;
// Detail hydration rate-limit handling (issue #28): the v2 LIST returns no
// content, so every observation costs one detail GET. On traces with many
// observations this bursts and Langfuse Cloud returns 429. Rather than failing
// the whole import (and restarting from scratch on the next attempt), we
// throttle requests globally, honor 429 Retry-After with in-run backoff, and
// retry the rate-limited observation in place so already-hydrated observations
// are preserved.
const DETAIL_INTER_REQUEST_MS = 100;
export const DETAIL_MAX_RETRIES = 5;
const DETAIL_BASE_BACKOFF_MS = 1_000;
const DETAIL_MAX_BACKOFF_MS = 60_000;
const DETAIL_HYDRATION_DEADLINE_MS = 10 * 60_000;

// A 429 from the per-id detail endpoint. Carries the server-advised wait so
// the hydration pool can back off the whole pool (Langfuse rate limits are
// project-wide, not per-request).
class LangfuseDetailRateLimitedError extends Error {
  readonly retryAfterMs: number | null;
  constructor(observationId: string, retryAfterMs: number | null) {
    const hint = retryAfterMs !== null ? ` (Retry-After: ${Math.round(retryAfterMs / 1000)}s)` : "";
    super(
      `Langfuse rate-limited the detail request for observation ${observationId}${hint}; backing off and retrying`,
    );
    this.name = "LangfuseDetailRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

// A 404 on an observation whose detail endpoint lags behind the LIST (issue #37).
// Langfuse ingestion is eventually consistent across its own endpoints: an
// observation can appear in the v2 LIST before its detail GET is available.
// This is transient — retry with backoff, same as a rate limit.
class LangfuseDetailNotReadyError extends Error {
  constructor(observationId: string, sourceTraceId: string) {
    super(
      `Langfuse returned 404 for observation ${observationId} (source trace ${sourceTraceId}); the detail endpoint lags the list — retrying`,
    );
    this.name = "LangfuseDetailNotReadyError";
  }
}
const FIELD_GROUPS = [
  "core",
  "basic",
  "time",
  "io",
  "metadata",
  "model",
  "usage",
  "metrics",
  "trace_context",
].join(",");
const DEFAULT_HOST = "https://cloud.langfuse.com";

type ResolveOptions = {
  hostFlag?: string;
  maxObservationsFlag?: string;
};

export function resolveConnectorConfig(options: ResolveOptions = {}): LangfuseConnectorConfig {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY ?? "").trim();

  // Surface missing var names without echoing any value the user supplied.
  if (!publicKey && !secretKey) {
    throw new Error(
      "Missing required environment variables: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
    );
  }
  if (!publicKey) {
    throw new Error("Missing required environment variable: LANGFUSE_PUBLIC_KEY");
  }
  if (!secretKey) {
    throw new Error("Missing required environment variable: LANGFUSE_SECRET_KEY");
  }

  const hostInput = (options.hostFlag || process.env.LANGFUSE_HOST || DEFAULT_HOST).trim();
  const host = normalizeHost(hostInput);
  const maxObservations = resolveMaxObservations(options.maxObservationsFlag);

  return { host, publicKey, secretKey, maxObservations };
}

export async function fetchLangfuseTrace(
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
  hydration: HydrationOptions = {},
): Promise<LangfuseTraceGraph> {
  const rows: LangfuseObservation[] = [];
  let cursor: string | null = null;

  do {
    const page = await fetchObservationPage(sourceTraceId, cursor, config);
    for (const row of page.data) {
      if (rows.length >= config.maxObservations) {
        throw new Error(
          `Langfuse trace ${sourceTraceId} exceeded --max-observations ceiling (${config.maxObservations}); aborting before any apo write`,
        );
      }
      rows.push(validateObservation(row, sourceTraceId));
    }
    cursor = page.meta.cursor ?? null;
  } while (cursor !== null);

  if (rows.length === 0) {
    throw new LangfuseEmptyTraceError(
      sourceTraceId,
      `Langfuse returned no observations for source trace ${sourceTraceId}`,
    );
  }
  if (rows.length > config.maxObservations) {
    throw new Error(
      `Langfuse trace ${sourceTraceId} exceeded --max-observations ceiling (${config.maxObservations}); aborting before any apo write`,
    );
  }

  // The v2 LIST endpoint returns only summary fields (id/type/timing/usage).
  // Content-bearing fields (name/input/output/metadata/model) live exclusively
  // on the per-id detail endpoint — hydrate each observation there before
  // handing the graph to the converter, otherwise imports arrive empty (issue #25).
  const observations = await hydrateObservations(rows, config, hydration);

  return {
    sourceHost: config.host,
    sourceTraceId,
    observations,
    trace: await fetchTraceAttribution(sourceTraceId, config),
  };
}

// Session/user identity lives only on the trace resource, never on an
// observation — without this GET an imported trace loses its session grouping
// (issue #189). Best-effort: attribution is enrichment, so a failure here
// degrades to an ungrouped import rather than a failed one.
async function fetchTraceAttribution(
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
): Promise<{ sessionId?: string | null; userId?: string | null } | undefined> {
  const url = new URL(
    `/api/public/traces/${encodeURIComponent(sourceTraceId)}`,
    config.host,
  );
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) return undefined;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = (
    "data" in parsed &&
    typeof (parsed as { data?: unknown }).data === "object" &&
    (parsed as { data?: unknown }).data !== null
      ? (parsed as { data: Record<string, unknown> }).data
      : (parsed as Record<string, unknown>)
  ) as Record<string, unknown>;
  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : null;
  const userId = typeof obj.userId === "string" ? obj.userId : null;
  if (sessionId === null && userId === null) return undefined;
  return { sessionId, userId };
}

/**
 * Structural evidence that a fetched set is only part of the trace, or null when
 * it looks whole.
 *
 * A count plateau cannot distinguish "ingestion finished" from "ingestion paused
 * between flush batches". The parent links can: an observation whose
 * `parentObservationId` is absent from the fetched set either hangs under a span
 * in the target trace (expected, merge mode) or under a span that has not been
 * ingested yet (a partial fetch). Only the parent's *identity* separates those —
 * counting doesn't, because several root observations legitimately share one
 * external parent when a runtime handles more than one query under the same
 * propagated span.
 *
 * So the caller declares the anchor via `externalParentSpanId`
 * (--parent-span-id): dangling links to that span are expected, any other
 * dangling link means its parent is still missing. Without an anchor there is
 * nothing to compare against in merge mode, and the gate stands down.
 */
export function findPartialFetchReason(
  observations: readonly LangfuseObservation[],
  options: { externalParentSpanId?: string; mergeMode: boolean },
): string | null {
  const present = new Set(observations.map((o) => o.id));
  const orphansByParent = new Map<string, number>();
  for (const observation of observations) {
    const parentId = observation.parentObservationId;
    if (!parentId || present.has(parentId)) continue;
    if (parentId === options.externalParentSpanId) continue;
    orphansByParent.set(parentId, (orphansByParent.get(parentId) ?? 0) + 1);
  }
  if (orphansByParent.size === 0) return null;

  // Merge mode with no declared anchor: a dangling parent is as likely to be the
  // span we are merging under as a missing one. Undecidable — let the quiet
  // period be the only gate rather than blocking every merge import.
  if (options.mergeMode && options.externalParentSpanId === undefined) return null;

  const tail = "not in the fetched set — those parent spans have not been ingested yet";
  if (orphansByParent.size > 1) {
    const orphans = [...orphansByParent.values()].reduce((a, b) => a + b, 0);
    return `${orphans} observations reference ${orphansByParent.size} distinct parents that are ${tail}`;
  }
  const [[parentId, childCount]] = [...orphansByParent.entries()];
  return `${childCount} observation(s) reference parent ${parentId}, which is ${tail}`;
}

export async function pollLangfuseTrace(
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
  options: LangfusePollOptions,
): Promise<LangfuseFetchResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const start = now();
  const deadline = start + options.totalDeadlineMs;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const stabilityIntervalMs = options.stabilityIntervalMs ?? DEFAULT_STABILITY_INTERVAL_MS;
  const structural = {
    mergeMode: options.mergeMode ?? false,
    ...(options.externalParentSpanId !== undefined
      ? { externalParentSpanId: options.externalParentSpanId }
      : {}),
  };
  let interval = options.initialIntervalMs;
  let attempts = 0;
  let lastCount = -1;
  // When the count last changed. The quiet period is measured from here.
  let lastChangeAt = start;
  // Set once a fetched set fails the structural check, so the deadline notice
  // can say what was wrong rather than just "the count was still growing".
  let lastPartialReason: string | null = null;

  const fetchGraph = () =>
    fetchLangfuseTrace(sourceTraceId, config, {
      now: options.now,
      sleep: options.sleep,
    });

  for (;;) {
    attempts += 1;
    const count = await countTraceObservations(sourceTraceId, config);

    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = now();
    }

    // Convergence: the count held steady for the whole quiet period AND the
    // fetched graph has no dangling parent links. The count gate is cheap
    // (list-only) and runs first; the structural gate is what actually catches
    // a mid-ingest plateau, and it needs the hydrated set.
    if (count > 0 && now() - lastChangeAt >= settleMs) {
      const graph = await fetchGraph();
      const reason = findPartialFetchReason(graph.observations, structural);
      if (reason === null) return { graph, notices: [] };
      lastPartialReason = reason;
      // Treat the partial set like a count change: restart the quiet period so
      // we don't re-hydrate on every poll while waiting for the rest.
      lastChangeAt = now();
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      if (count === 0) {
        throw new LangfuseEmptyTraceError(
          sourceTraceId,
          `Langfuse returned no observations for source trace ${sourceTraceId}` +
            ` after waiting ${Math.round(options.totalDeadlineMs / 1000)}s` +
            ` across ${attempts} attempt${attempts === 1 ? "" : "s"}.` +
            ` Ingestion may still be pending; safe to retry.`,
        );
      }
      // The trace existed but never looked complete within the deadline. Import
      // what we have (best effort) and warn — re-running later fills in the
      // spans that arrived after the snapshot (issue #39). Import is
      // idempotent: span ids are deterministic hashes, so no duplicates.
      const graph = await fetchGraph();
      const detail =
        lastPartialReason ?? `the count was still growing (${count} observation(s) seen)`;
      return {
        graph,
        notices: [
          `Source trace ${sourceTraceId} did not look fully ingested when --wait` +
            ` expired: ${detail}. Imported spans may be incomplete —` +
            ` re-run to repair (import is idempotent — stable span ids, no duplicates).`,
        ],
      };
    }

    // During the existence phase, use exponential backoff. Once the trace is
    // visible, poll at a fixed (shorter) interval so convergence is detected fast.
    const sleepFor =
      count > 0
        ? Math.min(stabilityIntervalMs, remaining)
        : Math.min(interval, options.maxIntervalMs, remaining);
    await sleep(sleepFor);
    if (count === 0) {
      interval = Math.min(interval * options.backoffFactor, options.maxIntervalMs);
    }
  }
}

/**
 * Paginates the v2 observations LIST and returns the total count, without
 * keeping the rows or hydrating details. Used by the poll loop to detect when
 * the observation count has converged (issue #39) — cheap list-only checks
 * avoid the expensive per-observation detail fan-out until stability is confirmed.
 */
async function countTraceObservations(
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  do {
    const page = await fetchObservationPage(sourceTraceId, cursor, config);
    const next = count + page.data.length;
    if (next > config.maxObservations) {
      throw new Error(
        `Langfuse trace ${sourceTraceId} exceeded --max-observations ceiling (${config.maxObservations}); aborting before any apo write`,
      );
    }
    count = next;
    cursor = page.meta.cursor ?? null;
  } while (cursor !== null);
  return count;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LangfuseObservationPage = {
  data: LangfuseObservation[];
  meta: { cursor?: string | null };
};

async function fetchObservationPage(
  sourceTraceId: string,
  cursor: string | null,
  config: LangfuseConnectorConfig,
): Promise<LangfuseObservationPage> {
  const url = buildObservationsUrl(config.host, sourceTraceId, cursor);
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Langfuse request timed out after ${PAGE_TIMEOUT_MS / 1000}s for source trace ${sourceTraceId}`,
      );
    }
    throw new Error(
      `Cannot reach Langfuse at ${config.host} for source trace ${sourceTraceId}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Langfuse authentication failed (${response.status}): credentials rejected for source trace ${sourceTraceId}. Check LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY and that the keys belong to the right Langfuse project.`,
    );
  }
  if (response.status === 404) {
    throw new Error(
      `Langfuse returned 404 for source trace ${sourceTraceId}`,
    );
  }
  if (response.status === 429) {
    throw new Error(
      `Langfuse rate-limited the request for source trace ${sourceTraceId}; safe to retry after backoff`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Langfuse request failed (${response.status}) for source trace ${sourceTraceId} at ${config.host}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(
      `Langfuse returned a non-JSON response for source trace ${sourceTraceId}`,
    );
  }
  return validateObservationPage(parsed, sourceTraceId);
}

function buildObservationsUrl(
  host: string,
  sourceTraceId: string,
  cursor: string | null,
): URL {
  const url = new URL("/api/public/v2/observations", host);
  url.searchParams.set("traceId", sourceTraceId);
  url.searchParams.set("fields", FIELD_GROUPS);
  // parseIoAsJson is intentionally NOT sent: Langfuse Cloud removed it from
  // the v2 observations endpoint and now 400s on it. I/O always comes back as
  // raw JSON strings and is parsed client-side in coerceIoField().
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

function validateObservationPage(
  parsed: unknown,
  sourceTraceId: string,
): LangfuseObservationPage {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Langfuse response for source trace ${sourceTraceId} was not an object`,
    );
  }
  const obj = parsed as { data?: unknown; meta?: unknown };
  if (!Array.isArray(obj.data)) {
    throw new Error(
      `Langfuse response for source trace ${sourceTraceId} is missing a 'data' array`,
    );
  }
  const meta = (obj.meta ?? {}) as { cursor?: string | null };
  return { data: obj.data as LangfuseObservation[], meta };
}

function validateObservation(
  row: unknown,
  sourceTraceId: string,
): LangfuseObservation {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(
      `Langfuse returned a non-object observation row for source trace ${sourceTraceId}`,
    );
  }
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.traceId !== "string" || typeof r.type !== "string") {
    throw new Error(
      `Langfuse observation for source trace ${sourceTraceId} is missing core fields (id/traceId/type)`,
    );
  }
  if (r.traceId !== sourceTraceId) {
    throw new Error(
      `Langfuse observation ${r.id} traceId (${r.traceId}) does not match requested source trace ${sourceTraceId}`,
    );
  }
  return {
    ...(row as object),
    input: coerceIoField(r.input),
    output: coerceIoField(r.output),
    metadata: coerceIoField(r.metadata),
  } as LangfuseObservation;
}

// --- Detail hydration -------------------------------------------------------
// The v2 LIST endpoint returns only summary fields; name/input/output/metadata/
// model only appear on GET /api/public/observations/{id}. We fetch the detail
// for every discovered observation (bounded concurrency) and merge it over the
// list row so content is never silently lost (issue #25).
//
// Rate-limit safety (issue #28): a trace with many observations fans out into
// one detail GET per observation, which bursts past Langfuse Cloud's project
// rate limit and gets 429'd. Rather than fail the import (and restart from
// zero on the next attempt), hydration:
//   1. Throttles detail requests GLOBALLY (smooth inter-request spacing).
//   2. Honors 429 Retry-After with exponential backoff.
//   3. Pauses the WHOLE pool on a 429 (rate limits are project-wide).
//   4. Retries the rate-limited observation in place, so observations already
//      hydrated by other workers are preserved.

async function hydrateObservations(
  rows: readonly LangfuseObservation[],
  config: LangfuseConnectorConfig,
  hydration: HydrationOptions,
): Promise<LangfuseObservation[]> {
  if (rows.length === 0) return [];
  const now = hydration.now ?? Date.now;
  const sleep = hydration.sleep ?? defaultSleep;

  const details: Record<string, unknown>[] = Array.from({ length: rows.length });
  // Shared, mutable coordination state across all workers in the pool. JS is
  // single-threaded and the only interleave points are `await`s, so these
  // read-modify-write blocks are race-free between workers.
  const gate = { pausedUntilMs: 0 }; // project-wide 429 backoff deadline
  const limiter = { nextAllowedAtMs: 0 }; // global request spacing
  const deadline = now() + DETAIL_HYDRATION_DEADLINE_MS;

  await runHydrationPool(rows, config, details, gate, limiter, deadline, now, sleep);

  return rows.map((row, i) => mergeObservation(row, details[i]!));
}

async function runHydrationPool(
  rows: readonly LangfuseObservation[],
  config: LangfuseConnectorConfig,
  details: Record<string, unknown>[],
  gate: { pausedUntilMs: number },
  limiter: { nextAllowedAtMs: number },
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      if (index >= rows.length) return;
      cursor += 1;
      details[index] = await fetchDetailWithRetry(
        rows[index]!,
        config,
        gate,
        limiter,
        deadline,
        now,
        sleep,
      );
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(DETAIL_CONCURRENCY, rows.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

async function fetchDetailWithRetry(
  row: LangfuseObservation,
  config: LangfuseConnectorConfig,
  gate: { pausedUntilMs: number },
  limiter: { nextAllowedAtMs: number },
  deadline: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<Record<string, unknown>> {
  let attempt = 0;
  let backoffMs = DETAIL_BASE_BACKOFF_MS;
  for (;;) {
    await throttleRequest(limiter, now, sleep);
    await waitForGate(gate, now, sleep);
    if (now() >= deadline) {
      throw new Error(
        `Langfuse detail hydration exceeded the ${Math.round(DETAIL_HYDRATION_DEADLINE_MS / 60_000)}min deadline at observation ${row.id} (source trace ${row.traceId}); safe to retry`,
      );
    }
    try {
      return await fetchObservationDetail(row.id, row.traceId, config, now);
    } catch (error) {
      // 404: detail endpoint lags the LIST (issue #37). The observation
      // exists (we saw it in the list) — retry with backoff until it
      // becomes available. Cheaper to retry than to fail the whole import.
      if (error instanceof LangfuseDetailNotReadyError) {
        if (attempt >= DETAIL_MAX_RETRIES) {
          throw new Error(
            `Langfuse detail endpoint still returned 404 for observation ${row.id} (source trace ${row.traceId}) after ${attempt + 1} attempts. Ingestion lag is unusually long; safe to retry.`,
          );
        }
        const waitMs = Math.min(backoffMs, DETAIL_MAX_BACKOFF_MS);
        await sleep(waitMs);
        attempt += 1;
        backoffMs = Math.min(backoffMs * 2, DETAIL_MAX_BACKOFF_MS);
        continue;
      }
      if (!(error instanceof LangfuseDetailRateLimitedError)) throw error;
      if (attempt >= DETAIL_MAX_RETRIES) {
        throw new Error(
          `Langfuse rate-limited the detail request for observation ${row.id} (source trace ${row.traceId}) after ${attempt + 1} attempts with backoff. The trace has too many observations to hydrate under the current Langfuse rate limit; safe to retry.`,
        );
      }
      // Honor the server's Retry-After when present, else exponential backoff.
      const waitMs = Math.min(error.retryAfterMs ?? backoffMs, DETAIL_MAX_BACKOFF_MS);
      // The rate limit is project-wide: pause every worker, not just this one.
      gate.pausedUntilMs = Math.max(gate.pausedUntilMs, now() + waitMs);
      await sleep(waitMs);
      attempt += 1;
      backoffMs = Math.min(backoffMs * 2, DETAIL_MAX_BACKOFF_MS);
    }
  }
}

// Space detail requests globally so the pool never bursts. Each call claims the
// next available slot and sleeps until it arrives. Synchronous between awaits,
// so the read-modify-write on nextAllowedAtMs is race-free across workers.
async function throttleRequest(
  limiter: { nextAllowedAtMs: number },
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const slotAt = limiter.nextAllowedAtMs;
  const current = now();
  limiter.nextAllowedAtMs = Math.max(slotAt, current) + DETAIL_INTER_REQUEST_MS;
  const wait = slotAt - current;
  if (wait > 0) await sleep(wait);
}

async function waitForGate(
  gate: { pausedUntilMs: number },
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const wait = gate.pausedUntilMs - now();
  if (wait > 0) await sleep(wait);
}

// Parse the Retry-After header (RFC 7231 §7.1.3): either delta-seconds or an
// HTTP-date. Returns null when absent or unparseable. `nowMs` anchors the
// HTTP-date form to an absolute wait duration.
function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const delta = parsed - nowMs;
    return delta > 0 ? delta : null;
  }
  return null;
}

async function fetchObservationDetail(
  observationId: string,
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
  now: () => number,
): Promise<Record<string, unknown>> {
  const url = new URL(
    `/api/public/observations/${encodeURIComponent(observationId)}`,
    config.host,
  );
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Langfuse detail request timed out after ${DETAIL_TIMEOUT_MS / 1000}s for observation ${observationId} (source trace ${sourceTraceId})`,
      );
    }
    throw new Error(
      `Cannot reach Langfuse detail endpoint for observation ${observationId} (source trace ${sourceTraceId})`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    throw new LangfuseDetailNotReadyError(observationId, sourceTraceId);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Langfuse authentication failed (${response.status}) fetching detail for observation ${observationId}`,
    );
  }
  if (response.status === 429) {
    // Hand control back to the hydration pool so it can back off the whole
    // pool (rate limits are project-wide) and retry this observation in place.
    throw new LangfuseDetailRateLimitedError(
      observationId,
      parseRetryAfter(response.headers.get("retry-after"), now()),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Langfuse detail request failed (${response.status}) for observation ${observationId} at ${config.host}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(
      `Langfuse detail response for observation ${observationId} was not JSON`,
    );
  }
  return validateDetailObject(parsed, observationId, sourceTraceId);
}

function validateDetailObject(
  parsed: unknown,
  observationId: string,
  sourceTraceId: string,
): Record<string, unknown> {
  // Some Langfuse builds wrap single resources in { data: {...} }; unwrap if so.
  const unwrapped =
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "data" in parsed &&
    (parsed as { data?: unknown }).data !== null &&
    typeof (parsed as { data?: unknown }).data === "object"
      ? (parsed as { data: Record<string, unknown> }).data
      : parsed;

  if (unwrapped === null || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    throw new Error(
      `Langfuse detail response for observation ${observationId} was not an object`,
    );
  }
  const obj = unwrapped as Record<string, unknown>;
  if (obj.id !== observationId) {
    throw new Error(
      `Langfuse detail response id (${String(obj.id)}) does not match requested observation ${observationId}`,
    );
  }
  // traceId is present on the detail payload; verify it lines up so a stale
  // or cross-trace detail never contaminates the graph.
  if (typeof obj.traceId === "string" && obj.traceId !== sourceTraceId) {
    throw new Error(
      `Langfuse detail for observation ${observationId} traceId (${obj.traceId}) does not match source trace ${sourceTraceId}`,
    );
  }
  return obj;
}

function mergeObservation(
  listRow: LangfuseObservation,
  detail: Record<string, unknown>,
): LangfuseObservation {
  // The detail endpoint is authoritative for content; spread it over the list
  // row (which still provides the structural backbone: parent/timing/usage).
  const merged = {
    ...listRow,
    ...detail,
    input: coerceIoField(detail.input),
    output: coerceIoField(detail.output),
    metadata: coerceIoField(detail.metadata),
    providedModelName: resolveModelName(detail, listRow),
  } as LangfuseObservation;
  return merged;
}

function resolveModelName(
  detail: Record<string, unknown>,
  listRow: LangfuseObservation,
): string | null | undefined {
  // The public REST detail endpoint names the field `model`; some self-hosted
  // builds mirror the OTLP `providedModelName`. Prefer whichever is present.
  if (typeof detail.providedModelName === "string") return detail.providedModelName;
  if (typeof detail.model === "string") return detail.model;
  return listRow.providedModelName ?? null;
}

// Both the v2 LIST rows and the per-id DETAIL payload may carry input/output/
// metadata either as raw JSON strings (Langfuse Cloud) or as already-parsed
// objects (self-hosted/older builds). Parse them back into structured JsonValue
// objects so the downstream converter can map gen_ai.input.messages etc. without
// special-casing strings. This runs against the DETAIL response today, since the
// list no longer returns content fields (issue #25).
//
//   undefined  -> undefined  (absent field)
//   null       -> null       (explicit JSON null)
//   "<json>"   -> parsed JSON value (falls back to the raw string on bad JSON)
//   <object>   -> unchanged  (self-hosted/older Langfuse may still send parsed)
function coerceIoField(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value as JsonValue;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    // Not valid JSON — preserve the raw string rather than dropping data.
    return value;
  }
}

function normalizeHost(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid LANGFUSE_HOST URL: ${redact(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `LANGFUSE_HOST must be http(s); got scheme ${url.protocol.replace(":", "")}`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      "LANGFUSE_HOST must not contain embedded credentials",
    );
  }
  // Origin-only: drop path/query/fragment. Lowercase scheme + host.
  return `${url.protocol}//${url.host}`;
}

function resolveMaxObservations(flag: string | undefined): number {
  if (!flag) return DEFAULT_MAX_OBSERVATIONS;
  const n = Number(flag);
  if (!Number.isInteger(n) || n < MIN_MAX_OBSERVATIONS || n > MAX_MAX_OBSERVATIONS) {
    throw new Error(
      `--max-observations must be an integer in ${MIN_MAX_OBSERVATIONS}..${MAX_MAX_OBSERVATIONS}; got ${redact(flag)}`,
    );
  }
  return n;
}

function redact(value: string): string {
  // Never echo back a value that might be a secret in disguise.
  if (value.length > 32) return value.slice(0, 8) + "...(redacted)";
  return value.replace(/[\w-]{8,}/g, "(redacted)");
}

export type { JsonValue };
