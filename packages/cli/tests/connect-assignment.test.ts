import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SourceOwnedAssignment } from "../src/lib/connected-executor.ts";

/*
 * Connector assignment scene test.
 *
 * Drives connect.ts::executeAssignment against a mocked Control Plane and a
 * stubbed child spawner, verifying the runtime is production-shaped:
 *  - real source hash (no all-zero placeholder)
 *  - task-scoped env into an isolated child (not in-process)
 *  - /attestation → /start → /result sequence with the scoped Attempt token
 *  - timeout surfaces as failure_kind=task_timeout
 */

const fixedDigest = "sha256:matched";
const fixedHash = "a".repeat(64);

vi.mock("../src/lib/task-meta.ts", () => ({
  discoverTaskMeta: () => [
    { id: "support/refund", path: "/ws/tasks/support/refund", display_name: "refund" },
  ],
}));
vi.mock("../src/lib/task-catalog.ts", () => ({
  toPublishedTask: (t: { id: string }) => ({ task_id: t.id }),
}));
vi.mock("../src/lib/task-catalog-digest.ts", () => ({ computeCatalogDigest: () => fixedDigest }));
vi.mock("../src/lib/task-revision.ts", () => ({
  walkWorkspaceForRevision: () => ({
    contentSha256: fixedHash,
    manifest: { summary: { fileCount: 7, uncompressedSizeBytes: 1234 } },
  }),
}));
vi.mock("../src/lib/git-provenance.ts", () => ({
  readGitProvenance: () => ({
    repositoryUrl: "https://github.com/o/r.git",
    baseCommitSha: "deadbeef",
    dirty: true,
  }),
}));

// Capture the options the parent passes to the isolated-child spawner; the
// env sanitization itself is unit-tested in local-task-child.test.ts.
let lastChildOpts: {
  traceEndpoint?: string;
  backendUrl?: string;
  project?: string;
  taskRunId?: string;
  attemptJwt?: string;
  timeoutSeconds?: number;
} | undefined = undefined;
let childOutcome: {
  ok: boolean;
  summary?: Record<string, unknown>;
  error?: string;
  timedOut?: boolean;
} = { ok: true, summary: { pass: true } };

vi.mock("../src/lib/local-task-child.ts", () => ({
  buildChildEnv: () => ({}),
  runTaskChild: vi.fn(async (opts: Record<string, unknown>) => {
    lastChildOpts = opts as never;
    return {
      ok: childOutcome.ok,
      summary: childOutcome.summary,
      error: childOutcome.error,
      timedOut: childOutcome.timedOut ?? false,
      stdoutTail: "",
      stderrTail: "",
    };
  }),
}));

const fetchCalls: { url: string; body: unknown }[] = [];
function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const assignment: SourceOwnedAssignment = {
  assignment_kind: "source_owned",
  attempt_id: "att-1",
  task_run_id: "run-1",
  batch_run_id: "bch-1",
  task_id: "support/refund",
  environment: "default",
  timeout_seconds: 30,
  project: "acme",
  catalog_digest: fixedDigest,
  lease_generation: 1,
  lease_expires_at: "2026-01-01T00:00:00Z",
  attempt_jwt: "attempt-jwt",
  trace_endpoint: "http://cp/otel",
  trace_required: true,
  result_max_bytes: 1024,
  diagnostic_tail_bytes: 100,
  run_metadata: null,
};

// Import after mocks are registered.
const { __executeAssignmentForTest: exec } = await import("../src/commands/connect.ts");

describe("connector assignment execution", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    lastChildOpts = undefined;
    childOutcome = { ok: true, summary: { pass: true, adapterName: "claude-code", traceRunId: "tr-1" } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | Request | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith("/source-attestation")) return jsonResp({ task_revision_id: "rev-1", content_sha256: "x" });
      if (url.endsWith("/start")) return jsonResp({ attempt_id: "att-1", status: "running", phase: "running" });
      if (url.endsWith("/heartbeat")) return jsonResp({ cancel_requested: false });
      if (url.endsWith("/result")) return jsonResp({ ok: true });
      if (url.endsWith("/failure")) return jsonResp({ ok: true });
      return jsonResp({});
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("submits a real source attestation (no placeholder) and the result via the isolated child", async () => {
    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);

    const attestation = fetchCalls.find((c) => c.url.endsWith("/source-attestation"))!.body as Record<string, unknown>;
    expect(attestation.content_sha256).toBe(fixedHash);
    expect(attestation.content_sha256).not.toBe("0".repeat(64));
    expect(attestation.file_count).toBe(7);
    expect(attestation.uncompressed_size_bytes).toBe(1234);
    expect(attestation.base_commit_sha).toBe("deadbeef");
    expect(attestation.repository_url).toBe("https://github.com/o/r.git");

    const result = fetchCalls.find((c) => c.url.endsWith("/result"))!.body as Record<string, unknown>;
    expect(result.pass_result).toBe(true);
    expect(result.completion_id).toContain("att-1");
  });

  it("submits the full result payload (deliverables, transcript, run_configuration)", async () => {
    childOutcome = {
      ok: true,
      summary: {
        pass: true,
        adapterName: "claude-code",
        traceRunId: "tr-9",
        deliverables: { verdict: "pass" },
        transcript: { turns: 3 },
        runConfiguration: { model: "claude-opus-4", effort: "high" },
      },
    };
    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);
    const result = fetchCalls.find((c) => c.url.endsWith("/result"))!.body as Record<string, unknown>;
    expect(result.deliverables).toEqual({ verdict: "pass" });
    expect(result.transcript).toEqual({ turns: 3 });
    expect(result.run_configuration).toEqual({ model: "claude-opus-4", effort: "high" });
    expect(result.trace_run_id).toBe("tr-9");
  });

  it("uses the backend base URL (not the server-reported trace_endpoint) for the child trace env", async () => {
    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);
    expect(lastChildOpts).toBeTruthy();
    // traceEndpoint must be the backend BASE URL, not the
    // server-provided full path. The SDK appends /api/public/otel/v1/traces
    // itself; a full-path value doubles it and drops every SDK span.
    expect(lastChildOpts!.traceEndpoint).toBe("http://cp");
    expect(lastChildOpts!.traceEndpoint).not.toContain("/api/public/otel");
    // BackendUrl is passed separately for artifact uploads.
    expect(lastChildOpts!.backendUrl).toBe("http://cp");
    expect(lastChildOpts!.project).toBe("acme");
    expect(lastChildOpts!.taskRunId).toBe("run-1");
    expect(lastChildOpts!.attemptJwt).toBe("attempt-jwt");
    expect(lastChildOpts!.timeoutSeconds).toBe(30);
  });

  it("fails task_import when the task_id is not present locally", async () => {
    await expect(
      exec!("http://cp", "/ws", { ...assignment, task_id: "missing/task" }, new AbortController().signal),
    ).rejects.toThrow(/not found locally/);
    const failure = fetchCalls.find((c) => c.url.endsWith("/failure"))!.body as Record<string, unknown>;
    expect(failure.failure_kind).toBe("task_import");
    // No false failed-check result is submitted to /result.
    expect(fetchCalls.find((c) => c.url.endsWith("/result"))).toBeUndefined();
  });

  it("reports timeout when the isolated child times out", async () => {
    childOutcome = { ok: false, error: "timeout", timedOut: true };
    await expect(
      exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal),
    ).rejects.toThrow(/timed out/);
    const failure = fetchCalls.find((c) => c.url.endsWith("/failure"))!.body as Record<string, unknown>;
    expect(failure.failure_kind).toBe("timeout");
    expect(fetchCalls.find((c) => c.url.endsWith("/result"))).toBeUndefined();
  });
});

describe("assignment heartbeat liveness (issue #176)", () => {
  beforeEach(() => {
    childOutcome = { ok: true, summary: { pass: true, adapterName: "claude-code", traceRunId: "tr-1" } };
    lastChildOpts = undefined;
    fetchCalls.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  function installFetch(overrides: {
    heartbeat?: () => Response;
    result?: () => Promise<Response> | Response;
    onBeat?: () => void;
  }): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | Request | string) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/heartbeat")) {
        overrides.onBeat?.();
        return overrides.heartbeat ? overrides.heartbeat() : jsonResp({ cancel_requested: false });
      }
      if (url.endsWith("/result")) {
        return overrides.result ? overrides.result() : jsonResp({ ok: true });
      }
      if (url.endsWith("/source-attestation")) return jsonResp({ task_revision_id: "rev-1", content_sha256: "x" });
      if (url.endsWith("/start")) return jsonResp({ attempt_id: "att-1", status: "running", phase: "running" });
      if (url.endsWith("/failure")) return jsonResp({ ok: true });
      return jsonResp({});
    });
  }

  it("keeps beating while the result POST is in flight", async () => {
    let resultInFlight = false;
    let beatsDuringResult = 0;
    installFetch({
      onBeat: () => { if (resultInFlight) beatsDuringResult += 1; },
      result: async () => {
        resultInFlight = true;
        await new Promise((r) => setTimeout(r, 120));
        resultInFlight = false;
        return jsonResp({ ok: true });
      },
    });

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal, 10);

    expect(beatsDuringResult).toBeGreaterThan(0);
  });

  it("aborts the child and warns when the heartbeat reports cancellation", async () => {
    installFetch({ heartbeat: () => jsonResp({ cancel_requested: true }) });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal, 10);

    // The beat stream is fire-and-forget: the cancellation warning and abort
    // can land right after executeAssignment returns.
    const cancelSignal = (lastChildOpts as { cancelSignal?: AbortSignal } | undefined)?.cancelSignal;
    await vi.waitFor(() => expect(cancelSignal?.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(errors.some((e) => e.toLowerCase().includes("cancel"))).toBe(true),
    );
  });

  it("warns loudly and aborts when the lease is lost (409)", async () => {
    installFetch({ heartbeat: () => jsonResp({ detail: { kind: "lease_stale" } }, 409) });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal, 10);

    const cancelSignal = (lastChildOpts as { cancelSignal?: AbortSignal } | undefined)?.cancelSignal;
    await vi.waitFor(() => expect(cancelSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(errors.some((e) => e.includes("lease lost"))).toBe(true));
  });

  it("warns on failed beats instead of swallowing them", async () => {
    installFetch({ heartbeat: () => jsonResp({}, 500) });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal, 10);

    await vi.waitFor(() =>
      expect(errors.some((e) => /heartbeat failed \(\d+ in a row\)/.test(e))).toBe(true),
    );
  });
});
