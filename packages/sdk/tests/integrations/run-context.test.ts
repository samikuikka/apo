import { describe, it, expect } from "vitest";
import { withApoRun, withApoRunSync, getActiveApoRun } from "../../src/agent-task/integrations/run-context.ts";
import type { AgentTaskTraceContext } from "../../src/agent-task/tracing.ts";

const noopTrace: AgentTaskTraceContext = {
  runId: "test-run",
  rootSpanId: "root",
  async step<T>(_opts: { step_name: string }, fn: (_s: string) => Promise<T>): Promise<T> {
    return fn("s");
  },
  recordEvent: () => "e",
  endRoot: () => {},
  async traceTool<T>(_n: string, _p: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async traceRetriever<T>(_q: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async traceChain<T>(_n: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async traceAgent<T>(_n: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async traceGuardrail<T>(_n: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async traceEmbedding<T>(_m: string, _i: unknown, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async score(_p: { name: string; value: number | string | boolean }): Promise<void> {},
  createSpan: () => "noop",
  endSpan: () => {},
};

describe("run-context (AsyncLocalStorage)", () => {
  it("returns undefined outside a run", () => {
    expect(getActiveApoRun()).toBeUndefined();
  });

  it("returns the context inside withApoRunSync", () => {
    const ctx = { trace: noopTrace, taskId: "t1" };
    withApoRunSync(ctx, () => {
      expect(getActiveApoRun()).toBe(ctx);
    });
    expect(getActiveApoRun()).toBeUndefined();
  });

  it("propagates through async boundaries", async () => {
    const ctx = { trace: noopTrace, taskId: "async-task" };
    await withApoRun(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getActiveApoRun()?.taskId).toBe("async-task");

      // nested async
      await (async () => {
        await new Promise((r) => setTimeout(r, 1));
        expect(getActiveApoRun()?.taskId).toBe("async-task");
      })();
    });
    expect(getActiveApoRun()).toBeUndefined();
  });

  it("isolates concurrent runs", async () => {
    const ctxA = { trace: noopTrace, taskId: "A" };
    const ctxB = { trace: noopTrace, taskId: "B" };

    const results: string[] = [];
    const run = (ctx: typeof ctxA) =>
      withApoRun(ctx, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        results.push(getActiveApoRun()!.taskId!);
      });

    await Promise.all([run(ctxA), run(ctxB)]);
    expect(results).toContain("A");
    expect(results).toContain("B");
    expect(results).toHaveLength(2);
  });
});
