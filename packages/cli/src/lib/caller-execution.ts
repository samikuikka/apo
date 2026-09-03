/**
 * CLI caller-execution client.
 *
 * Drives the caller create-and-claim protocol: POST /agent-task-batch-runs/caller
 * (Project API key) to atomically create the Batch + attested Revision + leased
 * caller Attempt, then /start, periodic /heartbeat, and /result or /failure
 * against the executor-protocol endpoints using the returned Attempt JWT (never
 * the Project API key). The raw API key stays in the CLI process and is never
 * injected into the Task environment.
 */

import { Worker } from "node:worker_threads";

import type { CallerIdentity } from "./git-provenance.ts";
import type { TaskDefinitionDocument } from "./task-definition.ts";

export interface CallerTaskDescriptor {
  task_id: string;
  task_path: string;
  display_name: string;
  adapter_name: string | null;
  has_checks: boolean;
}

export interface CallerSourceAttestation {
  source_type: "caller_worktree";
  repository_url: string | null;
  base_commit_sha: string | null;
  dirty: boolean;
  content_sha256: string;
  task_root_label: string;
  file_count: number;
  uncompressed_size_bytes: number;
}

export interface CallerLease {
  attemptId: string;
  generation: number;
  token: string; // Attempt JWT
  expiresAt: string;
}

export interface CreateCallerRunInput {
  backendUrl: string;
  apiKey: string;
  project: string;
  task: CallerTaskDescriptor;
  environment: string;
  runMetadata: Record<string, unknown> | null;
  attestation: CallerSourceAttestation;
  identity: CallerIdentity;
  /** Canonical Task Definition document. */
  taskDefinition: TaskDefinitionDocument;
}

export interface CreatedCallerRun {
  lease: CallerLease;
  batchRunId: string;
  taskRunId: string;
  traceEndpoint: string;
  traceProject: string;
}

export interface CallerResultBody {
  completion_id: string;
  pass_result: boolean;
  adapter_name?: string | null;
  trace_run_id?: string | null;
  checks?: unknown;
  transcript?: Record<string, unknown> | null;
  deliverables?: Record<string, unknown> | null;
  run_configuration?: { model: string; effort?: string } | null;
  exit_code?: number | null;
  stdout_tail?: string | null;
  stderr_tail?: string | null;
  error_message?: string | null;
}

export interface CallerFailureBody {
  completion_id: string;
  failure_kind: string;
  error_message?: string | null;
  exit_code?: number | null;
  stdout_tail?: string | null;
  stderr_tail?: string | null;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Bounds for the non-heartbeat protocol calls. A backend that accepts TCP
 * but stalls would otherwise wedge `apo task run` on undici's ~300s default;
 * the heartbeats already carry their own bound, these cover create/start
 * (control) and result/failure submission (potentially large bodies).
 */
const CONTROL_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;

/**
 * Per-request bound for one beat. Below the interval so an unanswered beat is
 * abandoned in time for its replacement to go out, and floored so a short
 * test interval still allows a real round-trip. The lease is ~4.5 intervals
 * wide, which leaves room for several bounded attempts before it is at risk.
 */
export function heartbeatTimeoutMs(intervalMs: number): number {
  return Math.max(1_000, Math.floor(intervalMs * 0.9));
}

/**
 * `409` from /heartbeat means the attempt is no longer ours — the reaper has
 * declared it `lost`, or another generation holds the lease. Retrying cannot
 * recover it and no result can be submitted against it, so this is stale-lease
 * news rather than a flaky beat.
 */
function isLeaseLostStatus(status: number | undefined): boolean {
  return status === 409;
}

export async function createCallerRun(input: CreateCallerRunInput): Promise<CreatedCallerRun> {
  const url = `${input.backendUrl.replace(/\/$/, "")}/v1/agent-task-batch-runs/caller`;
  const resp = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      project: input.project,
      task: input.task,
      environment: input.environment,
      run_metadata: input.runMetadata ?? {},
      source_attestation: input.attestation,
      caller_identity: input.identity,
      task_definition: input.taskDefinition,
    }),
  });
  if (!resp.ok) {
    throw new Error(`caller create failed: ${resp.status} ${await safeText(resp)}`);
  }
  const body = (await resp.json()) as {
    batch_run_id: string;
    task_run_id: string;
    attempt_id: string;
    lease_generation: number;
    lease_expires_at: string;
    attempt_jwt: string;
    trace_endpoint: string;
    trace_project: string;
  };
  return {
    batchRunId: body.batch_run_id,
    taskRunId: body.task_run_id,
    lease: {
      attemptId: body.attempt_id,
      generation: body.lease_generation,
      token: body.attempt_jwt,
      expiresAt: body.lease_expires_at,
    },
    traceEndpoint: body.trace_endpoint,
    traceProject: body.trace_project,
  };
}

function attemptUrl(backendUrl: string, lease: CallerLease, suffix: string): string {
  return `${backendUrl.replace(/\/$/, "")}/v1/executor-protocol/v1/attempts/${lease.attemptId}/${suffix}`;
}

function attemptHeaders(lease: CallerLease): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${lease.token}` };
}

export async function startCallerAttempt(backendUrl: string, lease: CallerLease): Promise<void> {
  const resp = await fetch(attemptUrl(backendUrl, lease, "start"), {
    method: "POST",
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    headers: attemptHeaders(lease),
    body: JSON.stringify({ driver_kind: "caller", runtime: {} }),
  });
  if (!resp.ok) throw new Error(`/start failed: ${resp.status} ${await safeText(resp)}`);
}

/** A non-ok /heartbeat, carrying the status so callers can tell terminal from flaky. */
export class HeartbeatHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`heartbeat failed: ${status} ${detail}`);
    this.name = "HeartbeatHttpError";
    this.status = status;
  }
}

export async function heartbeatCallerAttempt(
  backendUrl: string,
  lease: CallerLease,
  phase: string,
  timeoutMs: number = heartbeatTimeoutMs(DEFAULT_HEARTBEAT_INTERVAL_MS),
): Promise<{ cancelRequested: boolean }> {
  const resp = await fetch(attemptUrl(backendUrl, lease, "heartbeat"), {
    method: "POST",
    headers: attemptHeaders(lease),
    body: JSON.stringify({ phase }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new HeartbeatHttpError(resp.status, await safeText(resp));
  const body = (await resp.json()) as { cancel_requested?: boolean };
  return { cancelRequested: body.cancel_requested === true };
}

export async function submitCallerResult(
  backendUrl: string,
  lease: CallerLease,
  body: CallerResultBody,
): Promise<void> {
  const resp = await fetch(attemptUrl(backendUrl, lease, "result"), {
    method: "POST",
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    headers: attemptHeaders(lease),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`/result failed: ${resp.status} ${await safeText(resp)}`);
}

export async function submitCallerFailure(
  backendUrl: string,
  lease: CallerLease,
  body: CallerFailureBody,
): Promise<void> {
  const resp = await fetch(attemptUrl(backendUrl, lease, "failure"), {
    method: "POST",
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    headers: attemptHeaders(lease),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`/failure failed: ${resp.status} ${await safeText(resp)}`);
}

/**
 * A dumb POST pump, run on its own thread. It knows nothing about the executor
 * protocol: the main thread hands it a prepared request and it replays that
 * request every `intervalMs`, forwarding each response body back untouched.
 *
 * It lives on a worker thread because a heartbeat must not share a failure
 * domain with the work whose liveness it reports. `apo task run` executes the
 * Task in-process, so a `setInterval` heartbeat is starved by any synchronous
 * stretch of Task work — and four missed beats are enough for the lease reaper
 * to declare a perfectly healthy run `lost`.
 */
const HEARTBEAT_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { url, headers, body, intervalMs, timeoutMs } = workerData;
let inFlight = false;

async function tick() {
  // One beat at a time — but a beat that never returns must not become the
  // permanent state of the stream, so every request is bounded below the
  // interval. Without the bound this guard is a latch: the lease lapses while
  // the interval keeps firing into a request that will never settle.
  if (inFlight) return;
  inFlight = true;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      parentPort.postMessage({
        type: 'error',
        status: resp.status,
        message: 'heartbeat failed: ' + resp.status,
      });
    } else {
      // fetch resolves as soon as the response *headers* arrive; the body
      // can still stall or arrive cut short (observed behind a proxy that
      // flushes 200 headers and then times out). A beat whose body cannot
      // be read and parsed is a FAILED beat — it may have carried
      // cancel_requested, and counting it as success lets the lease lapse
      // with the client believing every beat landed (issue #176).
      let body = null;
      let parseError = null;
      try {
        body = await resp.json();
      } catch (err) {
        parseError = err && err.message ? err.message : String(err);
      }
      if (parseError !== null || body === null) {
        parentPort.postMessage({
          type: 'error',
          message: 'heartbeat response body unreadable (' + parseError + ')',
        });
      } else {
        parentPort.postMessage({ type: 'response', body });
      }
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  } finally {
    inFlight = false;
  }
}

void tick();
setInterval(() => void tick(), intervalMs);
`;

type HeartbeatWorkerMessage =
  | { type: "response"; body: { cancel_requested?: boolean } | null }
  | { type: "error"; status?: number; message: string };

/**
 * Background heartbeat lifecycle. Calls /heartbeat every `intervalMs` with the
 * current phase until stopped. If the lease reports stale/cancelled, the
 * callback is invoked so the caller can abort the Task and suppress a normal
 * result.
 *
 * The beat is issued from a worker thread so that Task work on the main thread
 * cannot starve it; if the worker cannot be created for any reason, this falls
 * back to an in-thread timer, which is the previous behaviour.
 */
export class CallerHeartbeat {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private consecutiveFailures = 0;
  private leaseLost = false;
  private lastGoodBeatAt = Date.now();
  private staleWarned = false;
  private readonly backendUrl: string;
  private readonly lease: CallerLease;
  private readonly onStale: () => void;
  private readonly intervalMs: number;

  constructor(
    backendUrl: string,
    lease: CallerLease,
    onStale: () => void,
    intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
  ) {
    this.backendUrl = backendUrl;
    this.lease = lease;
    this.onStale = onStale;
    this.intervalMs = intervalMs;
  }

  start(phase: string): void {
    this.lastGoodBeatAt = Date.now();
    try {
      this.worker = new Worker(HEARTBEAT_WORKER_SRC, {
        eval: true,
        workerData: {
          url: attemptUrl(this.backendUrl, this.lease, "heartbeat"),
          headers: attemptHeaders(this.lease),
          body: JSON.stringify({ phase }),
          intervalMs: this.intervalMs,
          timeoutMs: heartbeatTimeoutMs(this.intervalMs),
        },
      });
      this.worker.on("message", (msg: HeartbeatWorkerMessage) => {
        if (this.stopped) return;
        if (msg.type === "error") {
          if (isLeaseLostStatus(msg.status)) {
            this.noteLeaseLost();
            return;
          }
          this.noteFailure(msg.message);
          return;
        }
        // Only a parsed body counts as a good beat. An unparsed one means
        // the response was cut short — treat it as a failed beat, not as
        // silence with a reset failure count (issue #176).
        if (msg.body == null) {
          this.noteFailure("heartbeat response body missing");
          return;
        }
        this.consecutiveFailures = 0;
        this.lastGoodBeatAt = Date.now();
        this.staleWarned = false;
        if (msg.body.cancel_requested === true) this.onStale();
      });
      this.worker.on("error", (err: Error) => this.noteFailure(err.message));
      this.worker.on("exit", (code: number) => {
        if (this.stopped) return;
        this.noteFailure(`heartbeat worker exited unexpectedly (code ${code})`);
      });
      // Never hold the process open on the heartbeat's account.
      this.worker.unref();
      return;
    } catch (err) {
      this.worker = null;
      this.noteFailure(
        `heartbeat worker unavailable, falling back to in-thread timer: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.startInThread(phase);
  }

  private startInThread(phase: string): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const { cancelRequested } = await heartbeatCallerAttempt(
          this.backendUrl,
          this.lease,
          phase,
          heartbeatTimeoutMs(this.intervalMs),
        );
        this.consecutiveFailures = 0;
        this.lastGoodBeatAt = Date.now();
        this.staleWarned = false;
        if (cancelRequested) this.onStale();
      } catch (err) {
        if (err instanceof HeartbeatHttpError && isLeaseLostStatus(err.status)) {
          this.noteLeaseLost();
          return;
        }
        this.noteFailure(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  /**
   * A failed beat is not fatal on its own — the reaper is the authority — but
   * silence here is how a run gets declared `lost` with no warning at all, so
   * say something once the lease is genuinely at risk.
   */
  private noteFailure(message: string): void {
    this.consecutiveFailures += 1;
    console.error(
      `Warning: heartbeat failed (${this.consecutiveFailures} in a row): ${message}`,
    );
    this.warnIfNoGoodBeat();
  }

  /**
   * Issue #176 watchdog: per-beat errors cannot distinguish "beats are
   * failing" from "no beat has landed for a long time". The lease is ~4.5
   * intervals wide; once no good beat has landed for half that window, say
   * so in terms of the consequence — once per episode, until a beat lands.
   */
  private warnIfNoGoodBeat(): void {
    const sinceGoodMs = Date.now() - this.lastGoodBeatAt;
    if (this.staleWarned || sinceGoodMs < 2 * this.intervalMs) return;
    this.staleWarned = true;
    console.error(
      `Warning: no successful heartbeat for ${(sinceGoodMs / 1000).toFixed(1)}s — ` +
        "the backend may declare this run lost and discard its result",
    );
  }

  /**
   * The lease is gone. Say so once, in terms that name the consequence — a run
   * that keeps working here cannot submit anything — and hand control to the
   * caller through the same channel a cancellation uses.
   */
  private noteLeaseLost(): void {
    if (this.leaseLost) return;
    this.leaseLost = true;
    console.error(
      "Warning: lease lost (backend returned 409 for the heartbeat) — this attempt can no longer be finalized",
    );
    this.onStale();
  }

  /** Update the reported phase for subsequent heartbeats. */
  phase(_phase: string): void {
    // The phase is read at tick time; callers re-start with a new phase if needed.
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
