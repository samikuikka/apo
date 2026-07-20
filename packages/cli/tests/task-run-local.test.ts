import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Capture the env the CLI hands to the SDK before invoking runTaskDir.
const _captured: { env?: NodeJS.ProcessEnv; dir?: string } = {};

vi.mock("@apo/sdk/agent-task", () => ({
  // The CLI dynamically imports this module inside runLocally/runLocallyRecorded.
  runTaskDir: vi.fn(async (taskDir: string) => {
    _captured.env = { ...process.env };
    _captured.dir = taskDir;
    return {
      taskDir,
      taskId: "meeting-summary",
      pass: true,
      checks: [{ id: "c1", pass: true }],
      adapterName: "demoAdapter",
      traceRunId: "trace-local-1",
      deliverables: { summary: "ok" },
      transcript: { turns: [] },
    };
  }),
}));

// Import after mocks.
const { run } = await import("../src/commands/task-run.ts");
const { stripAnsi } = await import("../src/lib/format.ts");

let testDir: string;

function writeTaskFile(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  const taskName = dir.split(/[\\/]/).pop() ?? "task";
  writeFileSync(join(dir, `${taskName}.eval.ts`), content);
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `apo-task-local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  _captured.env = undefined;
  _captured.dir = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("task run --local", () => {
  it("creates an external batch, threads env to SDK, and reports the result back", async () => {
    const taskDir = join(testDir, "meeting-summary");
    writeTaskFile(
      taskDir,
      `import { task } from "@apo/sdk/agent-task";\ntask("meeting-summary", { adapter: "a" });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      // (1) isBackendReachable -> 200
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      // (2) POST /v1/agent-task-batch-runs/external -> 201 with token
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "batch-local-1",
            project: "example-service",
            status: "running",
            task_runs: [
              {
                id: "run-local-1",
                task_id: "meeting-summary",
                task_path: "meeting-summary",
                status: "running",
                started_at: "2026-07-20T10:00:00Z",
                trace_token: "token-abc",
              },
            ],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      // (3) POST /v1/agent-task-runs/run-local-1/result -> 200
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "run-local-1",
            batch_run_id: "batch-local-1",
            task_id: "meeting-summary",
            task_path: "meeting-summary",
            adapter_name: "demoAdapter",
            status: "passed",
            pass_result: true,
            started_at: "2026-07-20T10:00:00Z",
            completed_at: "2026-07-20T10:00:05Z",
            trace_run_id: "trace-local-1",
            error_message: null,
            total_cost: null,
            total_tokens: null,
            total_checks: 1,
            passed_checks: 1,
            failed_checks: 0,
            trigger: null,
            checks_json: [{ id: "c1", pass: true }],
            transcript_json: { turns: [] },
            deliverables_json: { summary: "ok" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await run([
      "meeting-summary",
      "--local",
      "--dir",
      testDir,
      "--backend",
      "http://backend.test",
      "--project",
      "example-service",
    ]);

    console.log = originalLog;

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // POST went to the external-create endpoint.
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://backend.test/v1/agent-task-batch-runs/external",
    );

    // Result report goes to the right path.
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://backend.test/v1/agent-task-runs/run-local-1/result",
    );
    const reportBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(reportBody.pass_result).toBe(true);
    expect(reportBody.adapter_name).toBe("demoAdapter");
    expect(reportBody.trace_run_id).toBe("trace-local-1");
    expect(reportBody.checks).toEqual([{ id: "c1", pass: true }]);

    // The SDK was given the minted token + task-run id + endpoint before being called.
    expect(_captured.env?.AGENT_TASK_RUN_ID).toBe("run-local-1");
    expect(_captured.env?.APO_AUTH_TOKEN).toBe("token-abc");
    expect(_captured.env?.AGENT_TASK_TRACE_ENDPOINT).toBe("http://backend.test");
    expect(_captured.env?.AGENT_TASK_PROJECT).toBe("example-service");
    expect(_captured.env?.AGENT_TASK_TRACE_REQUIRED).toBe("true");

    // Output mentions the run id so the user can inspect it.
    expect(logs.join("\n")).toContain("run-local-1");
  });

  it("falls back to unrecorded local run when backend is unreachable", async () => {
    const taskDir = join(testDir, "meeting-summary");
    writeTaskFile(
      taskDir,
      `import { task } from "@apo/sdk/agent-task";\ntask("meeting-summary", { adapter: "a" });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    // isBackendReachable -> network failure (caught, returns false)
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await run([
      "meeting-summary",
      "--local",
      "--dir",
      testDir,
      "--backend",
      "http://backend.test",
      "--project",
      "example-service",
    ]);

    console.warn = originalWarn;

    // Only the health-check fetch happened; no POSTs.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
    // A warning explained the degradation.
    expect(logs.join("\n")).toMatch(/unrecorded|backend/i);
  });

  it("returns exit code 1 when the local run fails checks", async () => {
    const taskDir = join(testDir, "failing-task");
    writeTaskFile(
      taskDir,
      `import { task } from "@apo/sdk/agent-task";\ntask("failing-task", { adapter: "a" });`,
    );

    // Override the SDK mock for this test to return a failing run.
    const { runTaskDir } = await import("@apo/sdk/agent-task");
    vi.mocked(runTaskDir).mockResolvedValueOnce({
      taskDir,
      taskId: "failing-task",
      pass: false,
      checks: [{ id: "c1", pass: false }],
      adapterName: "demoAdapter",
      traceRunId: "trace-fail",
      deliverables: {},
      transcript: { turns: [] },
    });

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "batch-fail",
            project: "example-service",
            status: "running",
            task_runs: [
              {
                id: "run-fail",
                task_id: "failing-task",
                task_path: "failing-task",
                status: "running",
                started_at: "2026-07-20T10:00:00Z",
                trace_token: "tok",
              },
            ],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "run-fail",
            batch_run_id: "batch-fail",
            task_id: "failing-task",
            task_path: "failing-task",
            adapter_name: "demoAdapter",
            status: "failed",
            pass_result: false,
            started_at: "2026-07-20T10:00:00Z",
            completed_at: "2026-07-20T10:00:05Z",
            trace_run_id: "trace-fail",
            error_message: null,
            total_cost: null,
            total_tokens: null,
            total_checks: 1,
            passed_checks: 0,
            failed_checks: 1,
            trigger: null,
            checks_json: [{ id: "c1", pass: false }],
            transcript_json: {},
            deliverables_json: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const code = await run([
      "failing-task",
      "--local",
      "--dir",
      testDir,
      "--backend",
      "http://backend.test",
      "--project",
      "example-service",
    ]);

    expect(code).toBe(1);
    // The failed verdict was reported to the backend.
    const reportBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(reportBody.pass_result).toBe(false);
  });

  // Issue #8: a run that ends with zero checks must not print a bare FAIL.
  it("prints the no-checks notice on an unrecorded local run with zero checks", async () => {
    const taskDir = join(testDir, "silent-task");
    writeTaskFile(
      taskDir,
      `import { task } from "@apo/sdk/agent-task";\ntask("silent-task", { adapter: "a" });`,
    );

    // Override the SDK mock to return a failed run with NO checks registered.
    const { runTaskDir } = await import("@apo/sdk/agent-task");
    vi.mocked(runTaskDir).mockResolvedValueOnce({
      taskDir,
      taskId: "silent-task",
      pass: false,
      checks: [],
      adapterName: "demoAdapter",
      deliverables: {},
      transcript: { turns: [] },
    });

    // No backend reachable -> unrecorded local run path (printLocalRunSummary).
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await run([
      "silent-task",
      "--dir",
      testDir,
      "--backend",
      "http://backend.test",
      "--project",
      "example-service",
    ]);

    console.log = originalLog;

    expect(code).toBe(1);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("FAIL silent-task");
    expect(out).toContain("No tests were registered");
    expect(out).toContain("test()");
  });

  // Issue #12: when a project source is configured, the backend inventory
  // keys tasks by their folder-scoped id (`chat/cost-inquiry`), not the bare
  // `task("cost-inquiry")` literal. The CLI must POST that folder-scoped id
  // so _resolve_inventory_rows matches — otherwise the run 409s with "No
  // tasks found for the given selection". This nested-tree run is the
  // regression guard for that bug.
  it("POSTs the folder-scoped id for a nested task tree (issue #12)", async () => {
    const taskDir = join(testDir, "chat", "cost-inquiry");
    writeTaskFile(
      taskDir,
      `import { task } from "@apo/sdk/agent-task";\ntask("cost-inquiry", { adapter: "a" });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "batch-nested",
            project: "example-service",
            status: "running",
            task_runs: [
              {
                id: "run-nested",
                task_id: "chat/cost-inquiry",
                task_path: "chat/cost-inquiry",
                status: "running",
                started_at: "2026-07-20T10:00:00Z",
                trace_token: "token-nested",
              },
            ],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "run-nested",
            batch_run_id: "batch-nested",
            task_id: "chat/cost-inquiry",
            task_path: "chat/cost-inquiry",
            adapter_name: "demoAdapter",
            status: "passed",
            pass_result: true,
            started_at: "2026-07-20T10:00:00Z",
            completed_at: "2026-07-20T10:00:05Z",
            trace_run_id: "trace-nested",
            error_message: null,
            total_cost: null,
            total_tokens: null,
            total_checks: 1,
            passed_checks: 1,
            failed_checks: 0,
            trigger: null,
            checks_json: [{ id: "c1", pass: true }],
            transcript_json: { turns: [] },
            deliverables_json: { summary: "ok" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    // Bare name resolves to the folder-scoped id (unique in this tree).
    const code = await run([
      "cost-inquiry",
      "--local",
      "--dir",
      testDir,
      "--backend",
      "http://backend.test",
      "--project",
      "example-service",
    ]);

    console.log = originalLog;

    expect(code).toBe(0);

    // The POST body MUST carry the folder-scoped id the backend inventory
    // keys on — this is the exact field the bug sent bare.
    const createBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(createBody.task_paths).toEqual(["chat/cost-inquiry"]);

    // The SDK got pointed at the nested task directory.
    expect(_captured.dir).toBe(taskDir);
    expect(_captured.env?.AGENT_TASK_RUN_ID).toBe("run-nested");
    expect(logs.join("\n")).toContain("run-nested");
  });

  it("prints the no-checks notice on a recorded --local run with zero checks", async () => {
    const taskDir = join(testDir, "silent-task");
    writeTaskFile(
      taskDir,
      `import { task } from "@apo/sdk/agent-task";\ntask("silent-task", { adapter: "a" });`,
    );

    const { runTaskDir } = await import("@apo/sdk/agent-task");
    vi.mocked(runTaskDir).mockResolvedValueOnce({
      taskDir,
      taskId: "silent-task",
      pass: false,
      checks: [],
      adapterName: "demoAdapter",
      traceRunId: "trace-silent",
      deliverables: {},
      transcript: { turns: [] },
    });

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "batch-silent",
            project: "example-service",
            status: "running",
            task_runs: [
              {
                id: "run-silent",
                task_id: "silent-task",
                task_path: "silent-task",
                status: "running",
                started_at: "2026-07-20T10:00:00Z",
                trace_token: "tok",
              },
            ],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "run-silent",
            batch_run_id: "batch-silent",
            task_id: "silent-task",
            task_path: "silent-task",
            adapter_name: "demoAdapter",
            status: "failed",
            pass_result: false,
            started_at: "2026-07-20T10:00:00Z",
            completed_at: "2026-07-20T10:00:05Z",
            trace_run_id: "trace-silent",
            error_message: null,
            total_cost: null,
            total_tokens: null,
            total_checks: 0,
            passed_checks: 0,
            failed_checks: 0,
            trigger: null,
            checks_json: [],
            transcript_json: {},
            deliverables_json: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await run([
      "silent-task",
      "--local",
      "--dir",
      testDir,
      "--backend",
      "http://backend.test",
      "--project",
      "example-service",
    ]);

    console.log = originalLog;

    expect(code).toBe(1);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("FAIL silent-task");
    expect(out).toContain("No tests were registered");
    expect(out).toContain("test()");
  });
});
