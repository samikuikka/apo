/**
 * pi adapter tests — everything except the real pi runtime.
 *
 * Unit tests drive the adapter against a fake pi session (injected factory)
 * and a recording trace; the scene test runs the REAL apo pipeline
 * (runTask → scheduler → checks) over a task whose eval wires the adapter to
 * a scripted fake via a globalThis factory hook — the same pattern as the
 * SDK's steering scene tests. No network, no pi catalog, no API keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  runTask,
  type AgentTaskTraceContext,
  type TaskDefinition,
} from "@apo-ai/sdk/agent-task";
import {
  createPiAdapter,
  type PiSessionEvent,
  type PiSessionLike,
} from "./pi-adapter.ts";

// ── Fake pi session ────────────────────────────────────────────────────────

interface FakePiSession extends PiSessionLike {
  /** Everything that happened, in order — e.g. "prompt", "steer:fix it". */
  log: string[];
  steerTexts: string[];
  disposed: boolean;
  /** Emit an event into the subscriber stream (test-driven idle chatter). */
  emit(event: PiSessionEvent): void;
}

function fakePiSession(options: {
  assistantText?: string;
  toolCount?: number;
  modelId?: string;
  models?: string[];
} = {}): FakePiSession {
  const listeners: Array<(event: PiSessionEvent) => void> = [];
  let modelId = options.modelId ?? "pi/default-model";
  let lastAssistant = "";
  const log: string[] = [];
  const steerTexts: string[] = [];
  let disposed = false;

  const emit = (event: PiSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  const session: FakePiSession = {
    log,
    steerTexts,
    get disposed() {
      return disposed;
    },
    emit,
    get model() {
      return { id: modelId };
    },
    modelRuntime: {
      getModels: () =>
        (options.models ?? ["pi/default-model", "deepseek/deepseek-v4.1-flash"]).map(
          (id) => ({ id }),
        ),
    },
    setModel: async (m: { id: string }) => {
      modelId = m.id;
    },
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    prompt: async (text: string) => {
      log.push(`prompt:${text}`);
      emit({ type: "agent_start" });
      const tools = options.toolCount ?? 3;
      for (let i = 1; i <= tools; i++) {
        await tick();
        emit({
          type: "tool_execution_end",
          toolCallId: `call-${i}`,
          toolName: i === 1 ? "ls" : "read",
          result: `data-${i}`,
          isError: false,
        });
      }
      await tick();
      const finalText =
        options.assistantText ??
        "Report body.\nTotal revenue: 9,200.00 (cancelled orders excluded)";
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          model: modelId,
        },
      });
      emit({ type: "agent_end" });
      lastAssistant = finalText;
    },
    steer: async (text: string) => {
      log.push(`steer:${text}`);
      steerTexts.push(text);
      return "queued";
    },
    getLastAssistantText: () => lastAssistant,
    dispose: () => {
      disposed = true;
    },
  };
  return session;
}

// ── Test scaffolding ───────────────────────────────────────────────────────

const noopTrace = {
  recordEvent: vi.fn(),
  step: vi.fn(async (_o: unknown, fn: (id: string) => Promise<unknown>) => fn("span-1")),
  endRoot: vi.fn(),
} as unknown as AgentTaskTraceContext;

const MINIMAL_TASK: TaskDefinition = {
  id: "pi-unit",
  adapter: "pi-agent",
  deliverables: ["result"],
};

function adapterWith(session: FakePiSession) {
  const adapter = createPiAdapter({
    createSession: async () => ({ session }),
  });
  return adapter;
}

async function startedSession(session: FakePiSession) {
  const adapter = adapterWith(session);
  const state =
    (await adapter.initialize?.({
      task: MINIMAL_TASK,
      taskDir: "/tmp",
      files: [],
      trace: noopTrace,
    })) ?? {};
  return adapter.startSession({
    task: MINIMAL_TASK,
    taskDir: "/tmp",
    files: [],
    state,
    trace: noopTrace,
  });
}

// ── Unit tests ─────────────────────────────────────────────────────────────

describe("pi adapter (fake session)", () => {
  it("routes pi events to apo progress notifications in order", async () => {
    const session = fakePiSession();
    const apo = await startedSession(session);

    const progress: string[] = [];
    await apo.sendUserTurn("build", {
      trace: noopTrace,
      turnNumber: 1,
      notifyAgentEvent: (event) =>
        progress.push(event.kind + ("toolName" in event ? `:${event.toolName}` : "")),
    });

    expect(progress).toEqual([
      "run_start",
      "tool_result:ls",
      "tool_result:read",
      "tool_result:read",
      "assistant_reply",
    ]);
  });

  it("maps adapter steer() onto pi session.steer() and reports the boundary", async () => {
    const session = fakePiSession();
    const apo = await startedSession(session);

    const result = await apo.steer!("exclude cancelled orders", {
      trace: noopTrace,
      turnNumber: 1,
      steerNumber: 1,
    });

    expect(session.steerTexts).toEqual(["exclude cancelled orders"]);
    expect(result.boundary).toBe("tool_results");
  });

  it("mirrors tool and generation observations into the trace as they arrive", async () => {
    const session = fakePiSession();
    const apo = await startedSession(session);
    const trace = {
      ...noopTrace,
      recordEvent: vi.fn(),
    } as unknown as AgentTaskTraceContext;

    await apo.sendUserTurn("build", {
      trace,
      turnNumber: 1,
      notifyAgentEvent: () => {},
    });

    const calls = (trace.recordEvent as ReturnType<typeof vi.fn>).mock.calls;
    const tools = calls.filter((c) => c[0]?.observation_type === "TOOL");
    const generations = calls.filter((c) => c[0]?.observation_type === "GENERATION");
    expect(tools.map((c) => c[0]?.tool_name)).toEqual(["ls", "read", "read"]);
    expect(generations).toHaveLength(1);
    expect(generations[0]?.[0]?.model).toBe("pi/default-model");
    expect(generations[0]?.[0]?.output?.text).toContain("Total revenue: 9,200.00");
  });

  it("extracts the response and collects full-text deliverables", async () => {
    const session = fakePiSession({
      assistantText: "A".repeat(3000) + "\nTotal revenue: 9,200.00",
    });
    const adapter = adapterWith(session);
    const state =
      (await adapter.initialize?.({
        task: MINIMAL_TASK, taskDir: "/tmp", files: [], trace: noopTrace,
      })) ?? {};
    const apo = await adapter.startSession({
      task: MINIMAL_TASK, taskDir: "/tmp", files: [], state, trace: noopTrace,
    });

    const turn = await apo.sendUserTurn("build", {
      trace: noopTrace, turnNumber: 1, notifyAgentEvent: () => {},
    });
    expect(String(turn.response)).toContain("Total revenue: 9,200.00");

    const deliverables = await adapter.collectDeliverables({
      task: MINIMAL_TASK, taskDir: "/tmp", files: [], state, session: apo, trace: noopTrace,
    });
    const summary = (deliverables.result as { summary: string }).summary;
    // Full text — the 500-char slice lesson must not come back.
    expect(summary.length).toBeGreaterThan(3000);
    expect((deliverables.result as { findings: string[] }).findings).toEqual([
      "ls", "read", "read",
    ]);
  });

  it("resolves PI_MODEL onto the session and reports the resolved id", async () => {
    const prev = process.env.PI_MODEL;
    process.env.PI_MODEL = "deepseek/deepseek-v4.1-flash";
    try {
      const session = fakePiSession();
      const apo = await startedSession(session);
      expect(apo.runConfiguration?.model).toBe("deepseek/deepseek-v4.1-flash");
    } finally {
      if (prev === undefined) delete process.env.PI_MODEL;
      else process.env.PI_MODEL = prev;
    }
  });

  it("keeps pi's default model when PI_MODEL names an unknown id", async () => {
    const prev = process.env.PI_MODEL;
    process.env.PI_MODEL = "not/a-model";
    try {
      const session = fakePiSession();
      const apo = await startedSession(session);
      expect(apo.runConfiguration?.model).toBe("pi/default-model");
    } finally {
      if (prev === undefined) delete process.env.PI_MODEL;
      else process.env.PI_MODEL = prev;
    }
  });

  it("disposes the pi session on close", async () => {
    const session = fakePiSession();
    const apo = await startedSession(session);
    await apo.close?.();
    expect(session.disposed).toBe(true);
  });

  it("drops events outside a turn (idle chatter never reaches the scheduler)", async () => {
    const session = fakePiSession();
    await startedSession(session);
    // No sendUserTurn active — pi emits idle events (extensions, compaction
    // chatter). The adapter must swallow them: no crash, no tool log growth.
    expect(() =>
      session.emit({
        type: "tool_execution_end",
        toolCallId: "idle",
        toolName: "read",
        result: "x",
        isError: false,
      }),
    ).not.toThrow();
    expect(session.log.some((entry) => entry.startsWith("prompt:"))).toBe(false);
  });
});

// ── Scene test: the real pipeline over the real adapter code ───────────────

const SCENE_ROOT = join(import.meta.dirname, "__pi_scene__");
const SCENE_FACTORY_KEY = "__piSceneSessionFactory";

describe("pi adapter scene — runTask end to end", () => {
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    g[SCENE_FACTORY_KEY] = async () => ({ session: fakePiSession() });
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[SCENE_FACTORY_KEY];
    if (existsSync(SCENE_ROOT)) rmSync(SCENE_ROOT, { recursive: true, force: true });
  });

  it("delivers a scheduled steer to the pi session mid-run and the checks pass", async () => {
    const taskDir = join(SCENE_ROOT, "pi-scene");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "adapter.ts"),
      `
import { createPiAdapter } from "${join(import.meta.dirname, "pi-adapter.ts")}";

const g = globalThis as Record<string, unknown>;
const factory = g.__piSceneSessionFactory as (opts: { cwd: string }) =>
  Promise<{ session: import("${join(import.meta.dirname, "pi-adapter.ts")}").PiSessionLike }>;

export const scenePiAdapter = createPiAdapter({ createSession: factory });
`,
    );
    writeFileSync(
      join(taskDir, "pi-scene.eval.ts"),
      `
import { task, turn, steer, test } from "@apo-ai/sdk/agent-task";
import { scenePiAdapter } from "./adapter.ts";

const { test: check } = task("pi-scene", {
  adapter: scenePiAdapter,
  deliverables: ["result"],
  maxTurns: 2,
});

turn(async (ctx) => (ctx.transcript.length === 0 ? "build the report" : null));

steer({ when: { toolResults: 2 }, label: "exclude-cancelled", message: "exclude cancelled orders" });

check("delivered", (t) => {
  t.steerDelivered(1);
});

check("post-steer-window", (t) => {
  t.afterSteer(1, (t2) => {
    t2.maxToolCalls(10);
  });
});
`,
    );

    const result = await runTask(taskDir);

    expect(result.result.pass).toBe(true);
    const steer = result.transcript.turns[0]?.steers?.[0];
    expect(steer?.status).toBe("delivered");
    expect(steer?.boundary).toBe("tool_results");
    expect(steer?.label).toBe("exclude-cancelled");
  });
});
