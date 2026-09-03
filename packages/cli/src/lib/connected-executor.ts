/**
 * Protocol v2 client for the source-owned Connected Executor.
 *
 * Provides the typed API calls for bootstrap, enrollment, heartbeat,
 * claims, source attestation, and attempt lifecycle — without ever
 * putting credentials in URLs or command-line arguments.
 */

import type { StoredExecutorState } from "./executor-state.ts";

export interface EnrollResponse {
  executor_id: string;
  credential: string;
  heartbeat_interval_seconds: number;
  lease_ttl_seconds: number;
}

export type CatalogEligibility =
  | { status: "ready"; project_catalog_digest: string }
  | { status: "catalog_mismatch"; project_catalog_digest: string }
  | { status: "catalog_missing"; project_catalog_digest: null };

export interface SourceOwnedAssignment {
  assignment_kind: "source_owned";
  attempt_id: string;
  task_run_id: string;
  batch_run_id: string;
  task_id: string;
  environment: string;
  timeout_seconds: number;
  project: string;
  catalog_digest: string;
  lease_generation: number;
  lease_expires_at: string;
  attempt_jwt: string;
  trace_endpoint: string;
  trace_required: true;
  result_max_bytes: number;
  diagnostic_tail_bytes: number;
  run_metadata: Record<string, unknown> | null;
}

export interface SourceAttestation {
  source_type: string;
  repository_url: string | null;
  base_commit_sha: string | null;
  dirty: boolean;
  content_sha256: string;
  task_root_label: string | null;
  file_count: number;
  uncompressed_size_bytes: number;
}

function v2Base(backendUrl: string): string {
  return `${backendUrl}/v1/executor-protocol/v2`;
}

export async function bootstrapAndEnroll(opts: {
  backendUrl: string;
  projectId: string;
  userAuthToken: string;
  name: string;
  taskRoot: string;
  concurrency: number;
}): Promise<StoredExecutorState> {
  const { backendUrl, projectId, userAuthToken, name, concurrency } = opts;

  // 1. Bootstrap
  const bootResp = await fetch(`${backendUrl}/v1/projects/${projectId}/connected-executor-bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${userAuthToken}`,
    },
    body: JSON.stringify({
      name: name || `connected-${Date.now().toString(36)}`,
      capabilities: {
        protocol_version: 2,
        executor_version: "0.1.0",
        assignment_kinds: ["source_owned"],
        driver_kinds: ["source-owned-ts"],
        os: process.platform,
        architecture: process.arch,
        runtimes: { node: process.version },
        max_concurrency: concurrency,
      },
    }),
  });

  if (!bootResp.ok) {
    const text = await bootResp.text();
    throw new Error(`Bootstrap failed (${bootResp.status}): ${text}`);
  }

  const boot = await bootResp.json() as { enrollment_token: string };

  // 2. Enroll
  const enrollResp = await fetch(`${v2Base(backendUrl)}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: boot.enrollment_token,
      name: name || `connected-${Date.now().toString(36)}`,
      capabilities: {
        protocol_version: 2,
        executor_version: "0.1.0",
        assignment_kinds: ["source_owned"],
        driver_kinds: ["source-owned-ts"],
        os: process.platform,
        architecture: process.arch,
        runtimes: { node: process.version },
        max_concurrency: concurrency,
      },
    }),
  });

  if (!enrollResp.ok) {
    const text = await enrollResp.text();
    throw new Error(`Enrollment failed (${enrollResp.status}): ${text}`);
  }

  const enrolled = await enrollResp.json() as EnrollResponse;

  return {
    schema_version: 1,
    backend_url: backendUrl,
    project_id: projectId,
    executor_id: enrolled.executor_id,
    executor_name: name,
    credential: enrolled.credential,
    created_at: new Date().toISOString(),
  };
}

export async function heartbeat(opts: {
  backendUrl: string;
  credential: string;
  catalogDigest: string;
  availableSlots: number;
}): Promise<CatalogEligibility> {
  const resp = await fetch(`${v2Base(opts.backendUrl)}/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.credential}`,
    },
    body: JSON.stringify({
      catalog_digest: opts.catalogDigest,
      available_slots: opts.availableSlots,
    }),
  });

  if (!resp.ok) {
    if (resp.status === 401) throw new Error("Executor credential invalid or revoked");
    throw new Error(`Heartbeat failed: ${resp.status}`);
  }

  return await resp.json() as CatalogEligibility;
}

/** structured claim result so the loop can honor server timing. */
export type ClaimWorkResult =
  | { kind: "assignment"; assignment: SourceOwnedAssignment }
  | { kind: "empty"; retryAfterMs: number }
  | { kind: "catalog_mismatch"; projectCatalogDigest: string | null; retryAfterMs: number };

/** Parse a ``Retry-After`` header (seconds) into milliseconds, default 5s. */
export function parseRetryAfterMs(headers: Headers, fallbackMs = 5_000): number {
  const raw = headers.get("retry-after");
  if (!raw) return fallbackMs;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return fallbackMs;
}

export async function claimWorkStructured(opts: {
  backendUrl: string;
  credential: string;
  catalogDigest: string;
  availableSlots: number;
}): Promise<ClaimWorkResult> {
  const resp = await fetch(`${v2Base(opts.backendUrl)}/claims`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.credential}`,
    },
    body: JSON.stringify({
      catalog_digest: opts.catalogDigest,
      available_slots: opts.availableSlots,
    }),
  });

  if (resp.status === 204) {
    return { kind: "empty", retryAfterMs: parseRetryAfterMs(resp.headers) };
  }
  if (resp.status === 409) {
    return {
      kind: "catalog_mismatch",
      projectCatalogDigest: null,
      retryAfterMs: parseRetryAfterMs(resp.headers, 10_000),
    };
  }
  if (resp.status === 401) throw new Error("Executor credential invalid or revoked");
  if (!resp.ok) throw new Error(`Claim failed: ${resp.status}`);

  const assignment = await resp.json() as SourceOwnedAssignment;
  return { kind: "assignment", assignment };
}

export async function submitAttestation(opts: {
  backendUrl: string;
  attemptJwt: string;
  attemptId: string;
  attestation: SourceAttestation;
}): Promise<{ task_revision_id: string; content_sha256: string }> {
  const resp = await fetch(`${v2Base(opts.backendUrl)}/attempts/${opts.attemptId}/source-attestation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.attemptJwt}`,
    },
    body: JSON.stringify(opts.attestation),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Attestation failed (${resp.status}): ${text}`);
  }

  return await resp.json();
}

export async function startAttempt(opts: {
  backendUrl: string;
  attemptJwt: string;
  attemptId: string;
}): Promise<{ attempt_id: string; status: string; phase: string | null }> {
  const resp = await fetch(`${v2Base(opts.backendUrl)}/attempts/${opts.attemptId}/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.attemptJwt}`,
    },
    body: JSON.stringify({ driver_kind: "source-owned-ts" }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Start failed (${resp.status}): ${text}`);
  }

  return await resp.json();
}

/** A non-ok /attempts/{id}/heartbeat, carrying the status (issue #176). */
export class AttemptHeartbeatHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Attempt heartbeat failed: ${status} ${detail}`);
    this.name = "AttemptHeartbeatHttpError";
    this.status = status;
  }
}

export async function heartbeatAttempt(opts: {
  backendUrl: string;
  attemptJwt: string;
  attemptId: string;
  phase: string;
  /** Per-beat bound; default 25s leaves headroom under the 30s interval. */
  timeoutMs?: number;
}): Promise<{ cancel_requested: boolean }> {
  const resp = await fetch(`${v2Base(opts.backendUrl)}/attempts/${opts.attemptId}/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.attemptJwt}`,
    },
    body: JSON.stringify({ phase: opts.phase }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
  });

  if (!resp.ok) {
    throw new AttemptHeartbeatHttpError(resp.status, await resp.text());
  }

  return await resp.json();
}

export async function submitResult(opts: {
  backendUrl: string;
  attemptJwt: string;
  attemptId: string;
  result: Record<string, unknown>;
}): Promise<void> {
  const resp = await fetch(`${v2Base(opts.backendUrl)}/attempts/${opts.attemptId}/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.attemptJwt}`,
    },
    body: JSON.stringify(opts.result),
  });

  if (!resp.ok) {
    throw new Error(`Result submission failed: ${resp.status}`);
  }
}

/** authoritative failure kinds for source-owned execution. */
export type SourceOwnedFailureKind =
  | "task_import"
  | "task_runtime"
  | "timeout"
  | "cancelled"
  | "executor_shutdown"
  | "driver"
  | "result_invalid"
  | "driver";

export async function submitFailure(opts: {
  backendUrl: string;
  attemptJwt: string;
  attemptId: string;
  failure: {
    completion_id: string;
    failure_kind: SourceOwnedFailureKind;
    error_message: string | null;
    exit_code: number | null;
    stdout_tail: string | null;
    stderr_tail: string | null;
  };
}): Promise<void> {
  const resp = await fetch(`${v2Base(opts.backendUrl)}/attempts/${opts.attemptId}/failure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.attemptJwt}`,
    },
    body: JSON.stringify(opts.failure),
  });

  if (!resp.ok) {
    throw new Error(`Failure submission failed: ${resp.status}`);
  }
}
