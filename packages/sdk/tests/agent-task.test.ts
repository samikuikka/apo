import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basename, dirname, join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { z } from "zod";
import { defineAdapter } from "../src/agent-task/adapter/defineAdapter";
import { runAdapterLifecycle } from "../src/agent-task/adapter/lifecycle";
import {
  parseAgentTaskCliArgs,
} from "../src/agent-task/cli";
import { validateDeliverables } from "../src/agent-task/deliverables/validate";
import { aggregateResult } from "../src/agent-task/run/aggregate";
import { runTask } from "../src/agent-task/run/runTask";
import { discoverAgentTaskDirs } from "../src/agent-task/discovery";
import { defineTask } from "../src/agent-task/task/defineTask";
import { loadTask } from "../src/agent-task/task/loadTask";
import { runTaskDir } from "../src/agent-task/task-runtime";
import { createNoopAgentTaskTraceContext } from "../src/agent-task/tracing";
import { turn, getTaskTurn, resetTaskTurn } from "../src/agent-task/turn";
import type {
  AdapterDefinition,
  DeliverableDefinition,
  TaskDefinition,
} from "../src/agent-task/types";

const TMP_ROOT = join(import.meta.dirname, "__agent_task_test__");
let taskDir = "";
const LOCAL_DEFINE_TASK_IMPORT = "../../../src/agent-task/task/defineTask";
const LOCAL_DEFINE_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";
const LOCAL_CHECKS_IMPORT = "../../../src/agent-task/public";

type TaskDirSetup = {
  taskContent: string;
  adapterContent?: string;
  checksContent?: string;
  files?: Record<string, string>;
};

function setupTaskDir(setup: TaskDirSetup): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, `${basename(taskDir)}.eval.ts`), setup.taskContent);

  if (setup.adapterContent) {
    writeFileSync(join(taskDir, "adapter.ts"), setup.adapterContent);
  }

  if (setup.checksContent) {
    writeFileSync(join(taskDir, "checks.ts"), setup.checksContent);
  }

  for (const [relativePath, content] of Object.entries(setup.files ?? {})) {
    const absolutePath = join(taskDir, "files", relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
}

function teardownTaskDir(): void {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
}

function buildAdapterModule(options?: {
  invalidReport?: boolean;
  includeStats?: boolean;
}): string {
  const reportValue = options?.invalidReport
    ? `{ title: 123, overview: "bad" }`
    : `{ title: "Summary", overview: "Source overview" }`;
  const statsSchema = options?.includeStats
    ? `stats: z.object({ turnCount: z.number() }),`
    : "";
  const statsValue = options?.includeStats ? `stats: { turnCount: 1 },` : "";

  return `
import { z } from "zod";
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";

export const testAdapter = defineAdapter({
  name: "test-adapter",
  deliverables: {
    report: z.object({ title: z.string(), overview: z.string() }),
    ${statsSchema}
  },
  turn: async ({ transcript }) => {
    if (transcript.length > 0) return null;
    return "test-prompt";
  },
  async startSession() {
    return {
      async sendUserTurn(turn: unknown) {
        return { response: "ack:" + String(turn) };
      },
    };
  },
  async collectDeliverables() {
    return {
      report: ${reportValue},
      ${statsValue}
    };
  },
});
`;
}

function buildTypedTaskModule(options?: {
  checks?: string | false;
  maxTurns?: number;
  deliverables?: string[];
}): string {
  const deliverables = JSON.stringify(options?.deliverables ?? ["report"]);
  const checks =
    options?.checks === false
      ? "checks: false,"
      : typeof options?.checks === "string"
        ? `checks: ${JSON.stringify(options.checks)},`
        : "";
  const maxTurns = options?.maxTurns
    ? `maxTurns: ${options.maxTurns},`
    : "";

  return `
import { defineTask } from "${LOCAL_DEFINE_TASK_IMPORT}";
import { testAdapter } from "./adapter";

export default defineTask(testAdapter, {
  id: "typed-task",
  description: "A typed task",
  ${maxTurns}
  ${checks}
  deliverables: ${deliverables},
});
`;
}

function buildSingleFileTaskModule(): string {
  return `
import { equals, task, test, turn } from "${LOCAL_CHECKS_IMPORT}";
import { testAdapter } from "./adapter";

task("single-file-task", {
  adapter: testAdapter,
  description: "Task, turn, and checks live together",
  deliverables: ["report"],
});

turn(async ({ transcript }) => {
  if (transcript.length > 0) return null;
  return "from-single-file-task";
});

test("report-title", (t, { deliverables }) => {
  t.check((deliverables.report as { title: string }).title, equals("Summary"));
});
`;
}

beforeEach(() => {
  teardownTaskDir();
  taskDir = join(
    TMP_ROOT,
    `case-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterAll(() => {
  teardownTaskDir();
});

describe("loadTask", () => {
  it("loads a typed task and returns its adapter definition", async () => {
    setupTaskDir({
      adapterContent: buildAdapterModule(),
      taskContent: buildTypedTaskModule(),
    });

    const loaded = await loadTask(taskDir);

    expect(loaded.task.id).toBe("typed-task");
    expect(loaded.task.adapter).toBe("test-adapter");
    expect(loaded.adapter.name).toBe("test-adapter");
    expect(typeof loaded.adapter.startSession).toBe("function");
    expect(loaded.files).toEqual([]);
    expect(loaded.checksPath).toBeNull();
  });

  it("requires task modules to export defineTask(adapter, ...) results", async () => {
    setupTaskDir({
      taskContent: `export default {
        id: "plain-task",
        adapter: "test-adapter",
        deliverables: ["report"],
      }`,
    });

    await expect(loadTask(taskDir)).rejects.toThrow(
      "Task module must default export defineTask(adapter, {...})",
    );
  });

  it("discovers files and checks", async () => {
    setupTaskDir({
      adapterContent: buildAdapterModule(),
      taskContent: buildTypedTaskModule({ maxTurns: 2 }),
      checksContent: `import { equals, test } from "${LOCAL_CHECKS_IMPORT}";
test("report-title", (t, { deliverables }) => {
  t.check((deliverables.report as { title: string }).title, equals("Summary"));
});`,
      files: {
        "instructions.md": "Start the conversation",
        "source.txt": "Source document",
      },
    });

    const loaded = await loadTask(taskDir);

    expect(loaded.files.map((file) => file.relativePath).sort()).toEqual([
      "instructions.md",
      "source.txt",
    ]);
    expect(loaded.checksPath).toBe(join(taskDir, "checks.ts"));
    expect(loaded.task.maxTurns).toBe(2);
  });

  it("loads and runs task, turn, and checks from the eval file", async () => {
    setupTaskDir({
      adapterContent: buildAdapterModule(),
      taskContent: buildSingleFileTaskModule(),
    });

    const loaded = await loadTask(taskDir);
    const result = await runTask(taskDir);

    expect(loaded.task.id).toBe("single-file-task");
    expect(loaded.inlineChecks).toBe(true);
    expect(loaded.checksPath).toBeNull();
    expect(result.transcript.turns[0].userAction).toBe(
      "from-single-file-task",
    );
    expect(result.result.checks).toMatchObject([
      {
        id: "report-title",
        pass: true,
        source_file: `${basename(taskDir)}.eval.ts`,
      },
    ]);
  });
});

describe("defineTask", () => {
  it("derives the adapter name from the typed adapter", () => {
    const adapter = defineAdapter({
      name: "local-adapter",
      deliverables: {
        report: z.object({ title: z.string() }),
      },
      async startSession() {
        return {
          async sendUserTurn() {
            return { response: "ok" };
          },
        };
      },
      async collectDeliverables() {
        return { report: { title: "ok" } };
      },
    });

    const task = defineTask(adapter, {
      id: "task-id",
      deliverables: ["report"],
    });

    expect(task.adapter).toBe("local-adapter");
    expect(task.deliverables).toEqual(["report"]);
  });
});

describe("turn", () => {
  it("registers a task-level turn callback", () => {
    const fn = async () => "hello" as const;
    turn(fn);
    expect(getTaskTurn()).toBe(fn);
    resetTaskTurn();
    expect(getTaskTurn()).toBeUndefined();
  });

  it("task-level turn overrides adapter-level turn", async () => {
    setupTaskDir({
      adapterContent: `
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";
import { z } from "zod";

export const testAdapter = defineAdapter({
  name: "test-adapter",
  deliverables: { result: z.object({ ok: z.boolean() }) },
  turn: async ({ transcript }) => {
    if (transcript.length > 0) return null;
    return "from-adapter";
  },
  async startSession() {
    return {
      async sendUserTurn(turn: unknown) {
        return { response: "ack:" + turn };
      },
    };
  },
  async collectDeliverables() {
    return { result: { ok: true } };
  },
});
`,
      taskContent: buildTypedTaskModule({ maxTurns: 3 }),
      checksContent: `import { equals, test, turn } from "${LOCAL_CHECKS_IMPORT}";
turn(async ({ transcript }) => {
  if (transcript.length > 0) return null;
  return "from-task";
});
test("result-ok", (t, { deliverables }) => {
  t.check((deliverables.result as { ok: boolean }).ok, equals(true));
});`,
      files: { "instructions.md": "go" },
    });

    const result = await runTask(taskDir);

    expect(result.result.pass).toBe(true);
    expect(result.transcript.turns[0].userAction).toBe("from-task");
  });

  it("adapter-level turn is used when no task-level turn exists", async () => {
    setupTaskDir({
      adapterContent: `
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";
import { z } from "zod";

export const testAdapter = defineAdapter({
  name: "test-adapter",
  deliverables: { result: z.object({ ok: z.boolean() }) },
  turn: async ({ transcript }) => {
    if (transcript.length > 0) return null;
    return "adapter-default";
  },
  async startSession() {
    return {
      async sendUserTurn(turn: unknown) {
        return { response: String(turn) };
      },
    };
  },
  async collectDeliverables() {
    return { result: { ok: true } };
  },
});
`,
      taskContent: buildTypedTaskModule({ maxTurns: 2 }),
      checksContent: `import { equals, test } from "${LOCAL_CHECKS_IMPORT}";
test("result-ok", (t, { deliverables }) => {
  t.check((deliverables.result as { ok: boolean }).ok, equals(true));
});`,
      files: { "instructions.md": "go" },
    });

    const result = await runTask(taskDir);

    expect(result.result.pass).toBe(true);
    expect(result.transcript.turns).toHaveLength(1);
    expect(result.transcript.turns[0].userAction).toBe("adapter-default");
  });
});

describe("validateDeliverables", () => {
  it("flags missing deliverables", () => {
    const task: TaskDefinition = {
      id: "t",
      adapter: "a",
      deliverables: ["report"],
    };

    const results = validateDeliverables(task, {});
    expect(results.results).toHaveLength(1);
    expect(results.results[0].id).toBe("deliverable:report");
    expect(results.brokenDeliverables.report).toContain("missing");
  });

  it("flags schema-invalid deliverables", () => {
    const task: TaskDefinition = {
      id: "t",
      adapter: "a",
      deliverables: ["report"],
    };
    const defs: Record<string, DeliverableDefinition> = {
      report: z.object({ title: z.string() }),
    };

    const results = validateDeliverables(task, { report: { title: 123 } }, defs);
    expect(results.results[0].pass).toBe(false);
    expect(results.results[0].reasoning).toContain("failed schema validation");
  });
});

describe("runAdapterLifecycle", () => {
  it("runs setup, session driving, collection, and cleanup in order", async () => {
    const order: string[] = [];
    const adapter: AdapterDefinition = {
      name: "test-adapter",
      deliverables: {},
      async initialize() {
        order.push("initialize");
        return { token: "state" };
      },
      async startSession() {
        order.push("startSession");
        return {
          async sendUserTurn() {
            order.push("sendUserTurn");
            return { response: "ok" };
          },
          async close() {
            order.push("close");
          },
        };
      },
      async collectDeliverables() {
        order.push("collectDeliverables");
        return { report: "done" };
      },
      async cleanup() {
        order.push("cleanup");
      },
    };

    const result = await runAdapterLifecycle(
      adapter,
      {
        task: { id: "t", adapter: "test-adapter", deliverables: ["report"] },
        taskDir,
        files: [],
      },
      async (session) => {
        await session.sendUserTurn(
          { content: "hello" },
          {
            trace: createNoopAgentTaskTraceContext(),
            turnNumber: 1,
          },
        );
      },
    );

    expect(result.deliverables).toEqual({ report: "done" });
    expect(order).toEqual([
      "initialize",
      "startSession",
      "sendUserTurn",
      "collectDeliverables",
      "cleanup",
      "close",
    ]);
  });
});

describe("aggregateResult", () => {
  it("fails when any check fails", () => {
    const result = aggregateResult([
      { id: "check-1", pass: true, reasoning: "" },
      { id: "check-2", pass: false, reasoning: "bad" },
    ]);

    expect(result.pass).toBe(false);
  });

  it("fails when there are zero checks (vacuous pass guard)", () => {
    const result = aggregateResult([]);

    expect(result.pass).toBe(false);
    expect(result.checks).toEqual([]);
  });

  it("passes when all checks pass", () => {
    const result = aggregateResult([
      { id: "check-1", pass: true, reasoning: "" },
    ]);

    expect(result.pass).toBe(true);
  });
});

describe("runTask", () => {
  it("runs a typed task end to end with adapter-level turn", async () => {
    setupTaskDir({
      adapterContent: `
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";

export const testAdapter = defineAdapter({
  name: "test-adapter",
  deliverables: {
    report: z.object({ title: z.string(), overview: z.string() }),
    stats: z.object({ turnCount: z.number(), attachmentCount: z.number() }),
  },
  turn: async ({ files, transcript }) => {
    if (transcript.length > 0) return null;
    return await files.read("instructions.md");
  },
  async startSession() {
    return {
      async sendUserTurn(turn: unknown) {
        return {
          response: { echoed: String(turn) },
        };
      },
    };
  },
  async collectDeliverables(ctx) {
    const source = readFileSync(join(ctx.taskDir, "files", "source.txt"), "utf-8");
    return {
      report: {
        title: "Summary",
        overview: source.trim(),
      },
      stats: {
        turnCount: 1,
        attachmentCount: ctx.files.length,
      },
    };
  },
});
`,
      taskContent: buildTypedTaskModule({
        maxTurns: 2,
        deliverables: ["report", "stats"],
      }),
      checksContent: `import { includes, test } from "${LOCAL_CHECKS_IMPORT}";
test("overview-present", (t, { deliverables }) => {
  t.check((deliverables.report as { overview: string }).overview, includes("Quarterly planning notes"));
});`,
      files: {
        "instructions.md": "Summarize the attached source.",
        "source.txt": "Quarterly planning notes with action items.",
      },
    });

    const result = await runTask(taskDir);

    expect(result.result.pass).toBe(true);
    expect(result.deliverables.report).toEqual({
      title: "Summary",
      overview: "Quarterly planning notes with action items.",
    });
    expect(result.transcript.turns).toHaveLength(1);
    expect(result.transcript.turns[0].userAction).toBe("Summarize the attached source.");
  });

  it("turns schema-invalid deliverables into failed checks", async () => {
    setupTaskDir({
      adapterContent: buildAdapterModule({ invalidReport: true }),
      taskContent: buildTypedTaskModule(),
      checksContent: `import { test } from "../../../src/agent-task/public";
test("report-title", (t, { deliverables }) => {
  void (deliverables.report as { title: string }).title;
});`,
    });

    const result = await runTask(taskDir);

    expect(result.result.pass).toBe(false);
    expect(result.result.checks[0].reasoning).toContain("failed schema validation");
  });

  it("propagates tracing through adapter contexts and returns the trace run id", async () => {
    const traceRun = vi.fn(async (_params, fn) =>
      fn({
        runId: "trace-run-1",
        rootSpanId: "root-span-1",
        async step(_options, stepFn) {
          return stepFn("span-1");
        },
        recordEvent() {
          return "event-1";
        },
        endRoot() {},
      }),
    );

    setupTaskDir({
      adapterContent: `
import { z } from "zod";
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";

export const testAdapter = defineAdapter({
  name: "test-adapter",
  deliverables: {
    report: z.object({ title: z.string(), overview: z.string() }),
  },
  turn: async ({ transcript }) => {
    if (transcript.length > 0) return null;
    return "trace-test";
  },
  async startSession(ctx) {
    let lastTraceRunId = ctx.trace.runId;

    return {
      async sendUserTurn(_turn, turnContext) {
        lastTraceRunId = turnContext.trace.runId;
        return { response: { traceRunId: lastTraceRunId } };
      },
    };
  },
  async collectDeliverables(ctx) {
    return {
      report: {
        title: "Summary",
        overview: ctx.trace.runId,
      },
    };
  },
});
`,
      taskContent: buildTypedTaskModule({ simulator: true }),
      files: {
        "instructions.md": "Summarize the attached source.",
      },
    });

    const result = await runTask(taskDir, {
      tracing: {
        client: { traceRun },
        project: "sdk-tests",
      },
    });

    expect(traceRun).toHaveBeenCalledTimes(1);
    expect(result.traceRunId).toBe("trace-run-1");
    expect(result.deliverables.report).toEqual({
      title: "Summary",
      overview: "trace-run-1",
    });
  });

});

describe("agent-task CLI helpers", () => {
  it("parses task runner arguments", () => {
    expect(
      parseAgentTaskCliArgs(["--dir", "e2e", "--grep", "meeting"]),
    ).toEqual({
      dir: "e2e",
      grep: "meeting",
    });
  });

  it("discovers nested task directories", () => {
    setupTaskDir({
      adapterContent: buildAdapterModule(),
      taskContent: buildTypedTaskModule(),
    });

    const secondTaskDir = join(TMP_ROOT, "second-task");
    mkdirSync(secondTaskDir, { recursive: true });
    writeFileSync(join(secondTaskDir, "adapter.ts"), buildAdapterModule());
    writeFileSync(join(secondTaskDir, "second-task.eval.ts"), buildTypedTaskModule());

    const discovered = discoverAgentTaskDirs(TMP_ROOT);
    expect(discovered).toEqual([secondTaskDir, taskDir].sort());
  });

  it("runs one task directory through the SDK runtime helpers", async () => {
    setupTaskDir({
      adapterContent: buildAdapterModule(),
      taskContent: buildTypedTaskModule(),
      checksContent: `import { equals, test } from "${LOCAL_CHECKS_IMPORT}";
test("report-title", (t, { deliverables }) => {
  t.check((deliverables.report as { title: string }).title, equals("Summary"));
});`,
    });

    const summary = await runTaskDir(taskDir);
    expect(summary.taskId).toBe("typed-task");
    expect(summary.pass).toBe(true);
  });
});
