import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Issue #251: a result too large for the envelope records anyway when the
 * server advertises result-evidence support. Drives `apo task run` with a
 * mocked backend that advertises a tiny result cap + evidence support and
 * a stubbed SDK summary whose transcript cannot fit inline.
 */

const bigTranscript = { messages: "x".repeat(64 * 1024) };

vi.mock("@apo-ai/sdk/agent-task", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@apo-ai/sdk/agent-task")>();
  return {
    ...actual,
    runTaskDir: async () => ({
      taskId: "t",
      pass: true,
      checks: [{ name: "c1", pass: true, received: "ok" }],
      adapterName: null,
      traceRunId: null,
      deliverables: {},
      transcript: bigTranscript,
    }),
    compactChecksForSubmission: (checks: unknown) => ({ checks }),
  };
});

import * as credentials from "../src/lib/credentials.ts";
import { run } from "../src/commands/task-run.ts";

function mockResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function writeTask(root: string): string {
  const taskDir = join(root, "caller-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "caller-task.eval.ts"),
    `import { task } from "@apo-ai/sdk/agent-task";\ntask("caller-task", { adapter: "a" });`,
  );
  return "caller-task";
}

describe("task run large-evidence recording", () => {
  let testDir: string;

  beforeEach(() => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-apo-test",
      project: "proj-test",
    });
    testDir = mkdtempSync(join(tmpdir(), "apo-task-run-evidence-"));
    writeTask(testDir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("uploads the oversized transcript out of band and finalizes by reference", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const rawBody = init?.body;
        calls.push({
          method: init?.method ?? "GET",
          url,
          body:
            typeof rawBody === "string"
              ? JSON.parse(rawBody)
              : rawBody instanceof Uint8Array
                ? Buffer.from(rawBody).toString("utf8")
                : rawBody,
        });
        if (url.includes("/health")) return new Response("ok", { status: 200 });
        if (url.includes("/agent-task-batch-runs/caller")) {
          return mockResp(
            {
              batch_run_id: "b1",
              task_run_id: "r1",
              attempt_id: "a1",
              lease_generation: 1,
              lease_expires_at: "2026-01-01T00:00:00Z",
              attempt_jwt: "jwt-1",
              trace_endpoint: "http://backend.test",
              trace_project: "proj-test",
              result_max_bytes: 4096,
              result_evidence_supported: true,
              result_evidence_max_item_bytes: 10 * 1024 * 1024,
              result_evidence_max_total_bytes: 512 * 1024 * 1024,
            },
            201,
          );
        }
        if (url.endsWith("/attempts/a1/start")) return mockResp({ status: "running" });
        if (url.endsWith("/attempts/a1/heartbeat")) return mockResp({ cancel_requested: false });
        if (url.endsWith("/result-evidence") && init?.method === "POST") {
          return mockResp(
            {
              id: "rev-1",
              slot: "transcript",
              status: "pending",
              upload_url: "/v1/executor-protocol/result-evidence/rev-1",
              upload_max_bytes: 104857600,
            },
            201,
          );
        }
        if (url.includes("/result-evidence/rev-1")) return mockResp({ id: "rev-1", status: "ready" });
        if (url.endsWith("/attempts/a1/result")) return mockResp({ status: "succeeded" });
        if (url.endsWith("/attempts/a1/failure")) return mockResp({ ok: true });
        return mockResp({}, 404);
      },
    );

    const code = await run([
      "caller-task", "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test",
    ]);
    expect(code).toBe(0);

    // The transcript left the result body and arrived as a verified part.
    const intent = calls.find((c) => c.url.endsWith("/result-evidence") && c.method === "POST");
    expect(intent).toBeDefined();
    expect(intent!.body).toMatchObject({ slot: "transcript" });
    const put = calls.find((c) => c.url.includes("/result-evidence/rev-1"));
    expect(put).toBeDefined();
    expect(String(put!.body)).toContain('"messages"');

    // The final result is small, references the part, and keeps the verdict.
    const result = calls.find((c) => c.url.endsWith("/attempts/a1/result"))!;
    expect(result.body).toMatchObject({
      completion_id: expect.any(String),
      pass_result: true,
      evidence_refs: ["rev-1"],
      transcript: null,
    });
    expect(JSON.stringify(result.body).length).toBeLessThan(4096);
    // No failure finalization happened — the run recorded.
    expect(calls.find((c) => c.url.endsWith("/failure"))).toBeUndefined();
  });

  it("falls back to the bounded rejection when the server has no evidence support", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        });
        if (url.includes("/health")) return new Response("ok", { status: 200 });
        if (url.includes("/agent-task-batch-runs/caller")) {
          // Old server: advertises the cap, not the evidence path.
          return mockResp(
            {
              batch_run_id: "b1",
              task_run_id: "r1",
              attempt_id: "a1",
              lease_generation: 1,
              lease_expires_at: "2026-01-01T00:00:00Z",
              attempt_jwt: "jwt-1",
              trace_endpoint: "http://backend.test",
              trace_project: "proj-test",
              result_max_bytes: 4096,
            },
            201,
          );
        }
        if (url.endsWith("/attempts/a1/start")) return mockResp({ status: "running" });
        if (url.endsWith("/attempts/a1/heartbeat")) return mockResp({ cancel_requested: false });
        if (url.endsWith("/attempts/a1/result")) return mockResp({ status: "succeeded" });
        if (url.endsWith("/attempts/a1/failure")) return mockResp({ ok: true });
        return mockResp({}, 404);
      },
    );

    const code = await run([
      "caller-task", "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test",
    ]);
    expect(code).toBe(2);
    // Issue #249 contract preserved: never sent the oversized body; the
    // failure endpoint carries the result_too_large diagnostic instead.
    expect(calls.find((c) => c.url.endsWith("/attempts/a1/result"))).toBeUndefined();
    const failure = calls.find((c) => c.url.endsWith("/attempts/a1/failure"))!;
    expect(failure.body).toMatchObject({ failure_kind: "result_invalid" });
    expect(String((failure.body as { error_message: string }).error_message)).toContain(
      "result_too_large",
    );
  });
});
