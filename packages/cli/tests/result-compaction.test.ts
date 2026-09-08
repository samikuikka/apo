import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SourceOwnedAssignment } from "../src/lib/connected-executor.ts";

/*
 * Result-submission compaction scene test (issue #175) + size-contract
 * rejection scenes (issue #249).
 *
 * Drives connect.ts::executeAssignment against a mocked Control Plane and a
 * stubbed child spawner whose summary carries judged checks with a large
 * ``received`` — the exact shape that produced 43 MB result bodies. Asserts
 * the /result wire body carries the backend's truncation marker instead of
 * the document copies, and that a body over the assignment's advertised
 * result_max_bytes is never POSTed to /result — it is finalized through
 * /failure as a bounded execution error instead.
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

let childOutcome: {
  ok: boolean;
  summary?: Record<string, unknown>;
  error?: string;
  timedOut?: boolean;
} = { ok: true, summary: { pass: true } };

vi.mock("../src/lib/local-task-child.ts", () => ({
  buildChildEnv: () => ({}),
  runTaskChild: vi.fn(async () => ({
    ok: childOutcome.ok,
    summary: childOutcome.summary,
    error: childOutcome.error,
    timedOut: childOutcome.timedOut ?? false,
    stdoutTail: "",
    stderrTail: "",
  })),
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
  // The server's shipped default (10 MiB): compaction must keep the MSA
  // shape far under it so /result — not /failure — carries the checks.
  result_max_bytes: 10_485_760,
  diagnostic_tail_bytes: 100,
  run_metadata: null,
};

const { __executeAssignmentForTest: exec } = await import("../src/commands/connect.ts");

/** 65 criteria judged against the same ~600 KB document — the MSA shape. */
function msaShapedSummary(docBytes: number): Record<string, unknown> {
  const document = "D".repeat(docBytes);
  return {
    pass: true,
    adapterName: "claude-code",
    checks: Array.from({ length: 65 }, (_, i) => ({
      id: `criterion-${i}`,
      pass: true,
      reasoning: "ok",
      assertions: [
        {
          id: "judge",
          pass: true,
          reasoning: "ok",
          received: document,
          evaluator_type: "llm",
        },
      ],
    })),
  };
}

function capturedResult(): Record<string, unknown> {
  return fetchCalls.find((c) => c.url.endsWith("/result"))!.body as Record<string, unknown>;
}

describe("result submission compaction", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    childOutcome = { ok: true, summary: { pass: true, adapterName: "claude-code" } };
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

  it("replaces oversized judged values with truncation markers on the wire", async () => {
    childOutcome = { ok: true, summary: msaShapedSummary(600 * 1024) };

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);

    const result = capturedResult();
    const checks = result.checks as Array<{ assertions: Array<{ received: unknown }> }>;
    expect(checks).toHaveLength(65);
    for (const check of checks) {
      const received = check.assertions[0].received as Record<string, unknown>;
      expect(received.kind).toBe("truncated");
      expect(received.size_bytes).toBeGreaterThan(600 * 1024);
      expect(typeof received.sha256).toBe("string");
    }
    // All 65 criteria reference the same document → identical markers.
    const first = JSON.stringify(checks[0].assertions[0].received);
    expect(checks.every((c) => JSON.stringify(c.assertions[0].received) === first)).toBe(true);
  });

  it("shrinks the wire body from N × document to ~N × marker", async () => {
    childOutcome = { ok: true, summary: msaShapedSummary(600 * 1024) };

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);

    const wireBytes = JSON.stringify(capturedResult()).length;
    // 65 × 600 KB ≈ 39 MB before; with markers the whole body is tiny.
    expect(wireBytes).toBeLessThan(100 * 1024);
  });

  it("keeps small received values inline on the wire", async () => {
    childOutcome = {
      ok: true,
      summary: {
        pass: true,
        adapterName: "claude-code",
        checks: [
          {
            id: "small",
            pass: true,
            reasoning: "",
            assertions: [{ id: "judge", pass: true, reasoning: "", received: "short value" }],
          },
        ],
      },
    };

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);

    const checks = capturedResult().checks as Array<{ assertions: Array<{ received: unknown }> }>;
    expect(checks[0].assertions[0].received).toBe("short value");
  });

  it("never POSTs a known-oversized result: bounded /failure instead (issue #249)", async () => {
    // A transcript larger than the advertised cap: legitimate large evidence
    // that compaction cannot shrink. The oversized body must never reach
    // /result; the Attempt is finalized through the small /failure endpoint.
    childOutcome = {
      ok: true,
      summary: {
        ...msaShapedSummary(600 * 1024),
        transcript: { messages: ["x".repeat(256 * 1024), "y".repeat(256 * 1024)] },
      },
    };

    await expect(
      exec!("http://cp", "/ws", { ...assignment, result_max_bytes: 512 * 1024 }, new AbortController().signal),
    ).rejects.toThrow(/result_too_large:/);

    const resultCalls = fetchCalls.filter((c) => c.url.endsWith("/result"));
    expect(resultCalls).toHaveLength(0);
    const failure = fetchCalls.find((c) => c.url.endsWith("/failure"));
    expect(failure).toBeDefined();
    expect(failure!.body.failure_kind).toBe("result_invalid");
    const message = failure!.body.error_message as string;
    expect(message.startsWith("result_too_large:")).toBe(true);
    expect(message).toContain(`limit_bytes=${512 * 1024}`);
    expect(message).toContain("transcript=");
    // Privacy: the diagnostic carries byte counts, never the subject text.
    expect(message).not.toContain("xxxx");
  });

  it("finalizes an explicit 413 from /result as a result_invalid execution error", async () => {
    // An intermediary (or a server with a smaller cap than advertised)
    // rejects a body below the cap. The typed status drives the definite-
    // rejection branch — not the ambiguous one — with no string parsing of
    // the (possibly HTML) response body.
    childOutcome = { ok: true, summary: { pass: true, adapterName: "claude-code" } };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | Request | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith("/source-attestation")) return jsonResp({ task_revision_id: "rev-1", content_sha256: "x" });
      if (url.endsWith("/start")) return jsonResp({ attempt_id: "att-1", status: "running", phase: "running" });
      if (url.endsWith("/heartbeat")) return jsonResp({ cancel_requested: false });
      if (url.endsWith("/result")) {
        return new Response("<html>413 Request Entity Too Large</html>", {
          status: 413,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.endsWith("/failure")) return jsonResp({ ok: true });
      return jsonResp({});
    });

    await expect(
      exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal),
    ).rejects.toThrow();

    const failure = fetchCalls.find((c) => c.url.endsWith("/failure"));
    expect(failure).toBeDefined();
    expect(failure!.body.failure_kind).toBe("result_invalid");
    expect(failure!.body.error_message).toContain("server_rejected_with=413");
  });

  it("does not send a contradictory failure when the result transport drops (ambiguous)", async () => {
    childOutcome = { ok: true, summary: { pass: true, adapterName: "claude-code" } };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | Request | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith("/source-attestation")) return jsonResp({ task_revision_id: "rev-1", content_sha256: "x" });
      if (url.endsWith("/start")) return jsonResp({ attempt_id: "att-1", status: "running", phase: "running" });
      if (url.endsWith("/heartbeat")) return jsonResp({ cancel_requested: false });
      if (url.endsWith("/result")) throw new Error("connection reset mid-upload");
      if (url.endsWith("/failure")) return jsonResp({ ok: true });
      return jsonResp({});
    });

    await expect(
      exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal),
    ).rejects.toThrow("connection reset mid-upload");

    // Ambiguous: the server may have committed before the drop — no /failure.
    expect(fetchCalls.some((c) => c.url.endsWith("/failure"))).toBe(false);
  });

  it("keeps the heartbeat alive through the slow failure finalization of an oversized result", async () => {
    const events: string[] = [];
    childOutcome = {
      ok: true,
      summary: { ...msaShapedSummary(600 * 1024), transcript: { blob: "t".repeat(1024 * 1024) } },
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | Request | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith("/source-attestation")) return jsonResp({ task_revision_id: "rev-1", content_sha256: "x" });
      if (url.endsWith("/start")) return jsonResp({ attempt_id: "att-1", status: "running", phase: "running" });
      if (url.endsWith("/heartbeat")) {
        events.push("heartbeat");
        return jsonResp({ cancel_requested: false });
      }
      if (url.endsWith("/result")) {
        events.push("result");
        return jsonResp({ ok: true });
      }
      if (url.endsWith("/failure")) {
        events.push("failure-start");
        await new Promise((r) => setTimeout(r, 80));
        events.push("failure-end");
        return jsonResp({ ok: true });
      }
      return jsonResp({});
    });

    await expect(
      exec!("http://cp", "/ws", { ...assignment, result_max_bytes: 512 * 1024 }, new AbortController().signal, 20),
    ).rejects.toThrow();
    // Beats continue landing while the failure POST is in flight — the last
    // heartbeat is not before "failure-start", and clearing happens after.
    expect(events).toContain("failure-start");
    const lastHeartbeat = events.lastIndexOf("heartbeat");
    expect(lastHeartbeat).toBeGreaterThan(events.indexOf("failure-start"));
    expect(events.indexOf("failure-end")).toBeGreaterThan(lastHeartbeat);
    // No retry of the same known-oversized body.
    expect(fetchCalls.filter((c) => c.url.endsWith("/result"))).toHaveLength(0);
  });

  it("reports a missing compaction export as a recording error, never a raw upload", async () => {
    // An SDK without compactChecksForSubmission (the reported CLI 0.6.0/SDK
    // 0.5.0 pair, issue #249): the judged checks must not silently ride the
    // wire uncompacted — the Attempt is finalized as result_invalid.
    // vi.doMock (not vi.mock — that hoists file-wide and breaks every other
    // scene in this file): scope the export-less SDK to this test's imports.
    vi.doMock("@apo-ai/sdk/agent-task", () => ({}));
    vi.resetModules();
    const { __executeAssignmentForTest: execFresh } = await import("../src/commands/connect.ts");
    childOutcome = { ok: true, summary: msaShapedSummary(600 * 1024) };

    await expect(
      execFresh!("http://cp", "/ws", { ...assignment }, new AbortController().signal),
    ).rejects.toThrow(/check compaction failed/);

    const failure = fetchCalls.find((c) => c.url.endsWith("/failure"));
    expect(failure).toBeDefined();
    expect(failure!.body.failure_kind).toBe("result_invalid");
    expect(String(failure!.body.error_message)).toContain("check compaction failed");
    expect(fetchCalls.some((c) => c.url.endsWith("/result"))).toBe(false);
    vi.doUnmock("@apo-ai/sdk/agent-task");
    vi.resetModules();
  });
});
