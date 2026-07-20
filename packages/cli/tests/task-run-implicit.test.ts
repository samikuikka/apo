import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import * as credentials from "../src/lib/credentials.ts";

// Mock the SDK runner so we never actually execute a task.
vi.mock("@apo/sdk/agent-task", () => ({
  runTaskDir: vi.fn(async (taskDir: string) => ({
    taskDir,
    taskId: basename(taskDir),
    pass: true,
    checks: [],
    adapterName: "demoAdapter",
    traceRunId: "trace-implicit",
    deliverables: { summary: "ok" },
    transcript: { turns: [] },
  })),
}));

const { run } = await import("../src/commands/task-run.ts");

let testDir: string;

function writeTask(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const name = basename(dir);
  writeFileSync(join(dir, `${name}.eval.ts`), body);
  return dir;
}

beforeEach(() => {
  testDir = join(tmpdir(), `apo-implicit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  // No stored credentials by default; individual tests opt in.
  vi.spyOn(credentials, "readCredentials").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

/** Capture console.log into a string. Returns [getOutput, restore]. */
function captureLog(): [() => string, () => void] {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  return [() => logs.join("\n"), () => { console.log = orig; }];
}

function captureWarn(): [() => string, () => void] {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => logs.push(args.join(" "));
  return [() => logs.join("\n"), () => { console.warn = orig; }];
}

const healthOk = () => new Response("ok", { status: 200 });
const externalCreated = (taskId: string) =>
  new Response(
    JSON.stringify({
      id: "batch-implicit",
      project: "example-service",
      status: "running",
      task_runs: [
        {
          id: "run-implicit",
          task_id: taskId,
          task_path: taskId,
          status: "running",
          started_at: "2026-07-20T10:00:00Z",
          trace_token: "tok-implicit",
        },
      ],
    }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
const resultReported = (taskId: string) =>
  new Response(
    JSON.stringify({
      id: "run-implicit",
      batch_run_id: "batch-implicit",
      task_id: taskId,
      task_path: taskId,
      adapter_name: "demoAdapter",
      status: "passed",
      pass_result: true,
      started_at: "2026-07-20T10:00:00Z",
      completed_at: "2026-07-20T10:00:05Z",
      trace_run_id: "trace-implicit",
      error_message: null,
      total_cost: null,
      total_tokens: null,
      total_checks: 0,
      passed_checks: 0,
      failed_checks: 0,
      trigger: null,
      checks_json: [],
      transcript_json: {},
      deliverables_json: { summary: "ok" },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
// Backend-subprocess batch create response (runViaBackend path). Returns a
// queued batch with no runs yet; pair with backendBatchCompleted + runDetail
// below so the polling loop (waitForTaskRun) completes without timing out.
function backendBatchQueued() {
  return new Response(
    JSON.stringify({
      id: "batch-backend",
      project: "example-service",
      status: "queued",
      task_runs: [],
    }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}
// Polling: batch is now complete with one passed run.
function backendBatchCompleted(taskId: string, taskPath: string) {
  return new Response(
    JSON.stringify({
      id: "batch-backend",
      project: "example-service",
      status: "completed",
      task_runs: [
        {
          id: "run-backend",
          batch_run_id: "batch-backend",
          task_id: taskId,
          task_path: taskPath,
          adapter_name: "demoAdapter",
          status: "passed",
          pass_result: true,
          started_at: "2026-07-20T10:00:01Z",
          completed_at: "2026-07-20T10:00:03Z",
          trace_run_id: "trace-backend",
          error_message: null,
          total_cost: null,
          trigger: null,
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
// Polling: run detail fetched after a terminal status.
function runDetail(taskId: string, taskPath: string) {
  return new Response(
    JSON.stringify({
      id: "run-backend",
      batch_run_id: "batch-backend",
      task_id: taskId,
      task_path: taskPath,
      adapter_name: "demoAdapter",
      status: "passed",
      pass_result: true,
      started_at: "2026-07-20T10:00:01Z",
      completed_at: "2026-07-20T10:00:03Z",
      trace_run_id: "trace-backend",
      error_message: null,
      total_cost: null,
      trigger: null,
      checks_json: [],
      transcript_json: {},
      deliverables_json: {},
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Set up the full fetch sequence for a runViaBackend dispatch. */
function mockBackendRun(fetchMock: ReturnType<typeof vi.spyOn>, taskId: string, taskPath: string): void {
  fetchMock
    .mockResolvedValueOnce(healthOk())
    .mockResolvedValueOnce(backendBatchQueued())
    .mockResolvedValueOnce(backendBatchCompleted(taskId, taskPath))
    .mockResolvedValueOnce(runDetail(taskId, taskPath));
}

const baseArgs = (taskId: string) => [
  taskId,
  "--dir",
  testDir,
  "--backend",
  "http://backend.test",
  "--project",
  "example-service",
];

function storedWithDefault(defaultExecution: "local" | "backend"): void {
  vi.spyOn(credentials, "readCredentials").mockReturnValue({
    backend_url: "http://backend.test",
    api_key: "key",
    project: "example-service",
    default_execution: defaultExecution,
  });
}

describe("task run — implicit local execution (SPEC-136)", () => {
  it("task declares execution: 'local' → hits /external with no flags + prints notice naming the task", async () => {
    writeTask(
      join(testDir, "bind-e2e"),
      `task("bind-e2e", { adapter: a, deliverables: ["summary"], execution: "local" });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(healthOk())
      .mockResolvedValueOnce(externalCreated("bind-e2e"))
      .mockResolvedValueOnce(resultReported("bind-e2e"));

    const [getLog, restore] = captureLog();
    const code = await run(baseArgs("bind-e2e"));
    restore();

    expect(code).toBe(0);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://backend.test/v1/agent-task-batch-runs/external",
    );
    // Implicit notice explains WHY local was chosen.
    expect(getLog()).toContain("execution=local");
    expect(getLog()).toContain("bind-e2e");
  });

  it("task execution: 'backend' wins over a 'local' project default → runViaBackend", async () => {
    storedWithDefault("local"); // project says local...
    const taskPath = writeTask(
      join(testDir, "safe-task"),
      `task("safe-task", { adapter: a, execution: "backend" });`, // ...task says backend
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockBackendRun(fetchMock, "safe-task", taskPath);

    await run(baseArgs("safe-task"));

    // Task wins → backend-subprocess endpoint, NOT /external.
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://backend.test/v1/agent-task-batch-runs",
    );
  });

  it("--remote flag overrides task execution: 'local'", async () => {
    const taskPath = writeTask(
      join(testDir, "local-task"),
      `task("local-task", { adapter: a, execution: "local" });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockBackendRun(fetchMock, "local-task", taskPath);

    await run([...baseArgs("local-task"), "--remote"]);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://backend.test/v1/agent-task-batch-runs",
    );
  });

  it("--local flag overrides task execution: 'backend'", async () => {
    writeTask(
      join(testDir, "backend-task"),
      `task("backend-task", { adapter: a, execution: "backend" });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(healthOk())
      .mockResolvedValueOnce(externalCreated("backend-task"))
      .mockResolvedValueOnce(resultReported("backend-task"));

    await run([...baseArgs("backend-task"), "--local"]);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://backend.test/v1/agent-task-batch-runs/external",
    );
  });

  it("project default 'local' with no task preference → /external + notice names project default", async () => {
    storedWithDefault("local");
    writeTask(
      join(testDir, "plain-task"),
      `task("plain-task", { adapter: a, deliverables: ["summary"] });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(healthOk())
      .mockResolvedValueOnce(externalCreated("plain-task"))
      .mockResolvedValueOnce(resultReported("plain-task"));

    const [getLog, restore] = captureLog();
    const code = await run(baseArgs("plain-task"));
    restore();

    expect(code).toBe(0);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://backend.test/v1/agent-task-batch-runs/external",
    );
    expect(getLog()).toContain("project default");
    expect(getLog()).toContain("local");
  });

  it("legacy task (no execution, no project default), backend reachable → runViaBackend, NO notice", async () => {
    const taskPath = writeTask(
      join(testDir, "legacy"),
      `task("legacy", { adapter: a, deliverables: ["result"] });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockBackendRun(fetchMock, "legacy", taskPath);

    const [getLog, restore] = captureLog();
    await run(baseArgs("legacy"));
    restore();

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://backend.test/v1/agent-task-batch-runs",
    );
    expect(getLog()).not.toContain("execution=local");
    expect(getLog()).not.toContain("project default");
  });

  it("degrades to unrecorded local run when implicit-local is chosen but backend is unreachable", async () => {
    writeTask(
      join(testDir, "local-task"),
      `task("local-task", { adapter: a, execution: "local" });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const [getWarn, restore] = captureWarn();
    const code = await run(baseArgs("local-task"));
    restore();

    // Only the health-check fetch happened; no POSTs to /external.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
    expect(getWarn()).toMatch(/unrecorded|backend/i);
  });

  it("project default 'local' also degrades to unrecorded when backend is unreachable", async () => {
    storedWithDefault("local");
    writeTask(
      join(testDir, "plain-task"),
      `task("plain-task", { adapter: a });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const code = await run(baseArgs("plain-task"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });
});
