import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the heavy collaborators so runTaskDir can be exercised in isolation.
// We capture what `tracing` object it builds and passes to runTask, plus the
// shape of the summary it returns.
const _captured: { tracing?: unknown; runtime?: unknown; loaded?: unknown } = {};

vi.mock("../src/agent-task/task/loadTask", () => ({
  loadTask: vi.fn(async () => ({
    task: { id: "fake-task", deliverables: [], maxTurns: 1 },
    adapter: { name: "fake-adapter" },
    taskDir: "/tmp/fake",
    files: [],
    checksPath: null,
    inlineChecks: true,
    moduleUrl: "file:///tmp/fake/fake.eval.ts",
    evalFileName: "fake.eval.ts",
  })),
}));

vi.mock("../src/agent-task/run/runTask", () => ({
  runTask: vi.fn(async (_taskDir: string, options?: { tracing?: unknown; loaded?: unknown }) => {
    _captured.tracing = options?.tracing;
    _captured.loaded = options?.loaded;
    return {
      task: { id: "fake-task" },
      taskDir: "/tmp/fake",
      files: [],
      traceRunId: "trace-xyz",
      result: { pass: true, checks: [] },
      deliverables: { summary: "ok" },
      transcript: { turns: [] },
    };
  }),
}));

// Import after mocks are registered.
const { runTaskDir } = await import("../src/agent-task/task-runtime");
const { loadTask } = await import("../src/agent-task/task/loadTask");
const { runTask } = await import("../src/agent-task/run/runTask");

describe("runTaskDir threading (Issue #4)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _captured.tracing = undefined;
    _captured.runtime = undefined;
    _captured.loaded = undefined;
  });

  afterEach(() => {
    // Restore env without mutating process.env's shape.
    process.env = { ...originalEnv };
  });

  it("passes taskRunId into tracing when AGENT_TASK_RUN_ID is set", async () => {
    process.env.AGENT_TASK_TRACE_ENDPOINT = "http://localhost:8000";
    process.env.AGENT_TASK_PROJECT = "proj-1";
    process.env.AGENT_TASK_RUN_ID = "run-abc";

    const summary = await runTaskDir("/tmp/fake");

    const tracing = _captured.tracing as { taskRunId?: string } | undefined;
    expect(tracing).toBeDefined();
    expect(tracing?.taskRunId).toBe("run-abc");

    // Widened summary carries the trace id so the CLI can POST it back.
    expect(summary.traceRunId).toBe("trace-xyz");
  });

  it("omits taskRunId when AGENT_TASK_RUN_ID is unset", async () => {
    process.env.AGENT_TASK_TRACE_ENDPOINT = "http://localhost:8000";
    process.env.AGENT_TASK_PROJECT = "proj-1";
    delete process.env.AGENT_TASK_RUN_ID;

    await runTaskDir("/tmp/fake");

    const tracing = _captured.tracing as { taskRunId?: string } | undefined;
    expect(tracing).toBeDefined();
    expect(tracing?.taskRunId).toBeUndefined();
  });

  it("keeps tracing undefined when endpoint/project are missing (offline)", async () => {
    delete process.env.AGENT_TASK_TRACE_ENDPOINT;
    delete process.env.AGENT_TASK_PROJECT;
    delete process.env.AGENT_TASK_RUN_ID;

    await runTaskDir("/tmp/fake");

    expect(_captured.tracing).toBeUndefined();
  });

  it("surfaces adapter name and deliverables in the summary", async () => {
    process.env.AGENT_TASK_TRACE_ENDPOINT = "http://localhost:8000";
    process.env.AGENT_TASK_PROJECT = "proj-1";
    process.env.AGENT_TASK_RUN_ID = "run-abc";

    const summary = await runTaskDir("/tmp/fake");

    expect(summary.taskId).toBe("fake-task");
    expect(summary.pass).toBe(true);
    // Optional fields are present so the CLI can forward them to the backend.
    expect(summary).toHaveProperty("adapterName");
    expect(summary).toHaveProperty("deliverables");
    expect(summary).toHaveProperty("transcript");
  });
});

describe("runTaskDir loads the eval exactly once (Issue #7)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("threads the LoadedTask into runTask so loadTask is not called twice", async () => {
    vi.mocked(loadTask).mockClear();
    vi.mocked(runTask).mockClear();

    await runTaskDir("/tmp/fake");

    // loadTask fires exactly once (the runTaskDir call itself), not again
    // inside runTask — the eval module's top level must run only once per run.
    expect(loadTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledTimes(1);

    // runTask received the already-loaded task via options.loaded, so it has
    // no reason to re-import the eval file.
    const loadedArg = _captured.loaded as { task?: { id?: string } } | undefined;
    expect(loadedArg).toBeDefined();
    expect(loadedArg?.task?.id).toBe("fake-task");
  });
});
