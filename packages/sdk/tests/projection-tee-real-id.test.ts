/**
 * Regression test for the projection-tee span-id bug.
 *
 * The tee wraps a real trace context. Its createSpan must propagate the real
 * context's span id so endSpan can close the real span. Before the fix, the
 * tee generated its own id, discarded real.createSpan's return, and called
 * real.endSpan with the tee id — which never matched, so the real span was
 * never ended (never exported, usage lost).
 *
 * This test uses a RECORDING real context (not a noop) and asserts that
 * endSpan receives an id that createSpan actually issued, with the token
 * params intact. It would have caught the original bug.
 */
import { describe, it, expect } from "vitest";
import { createProjectionTee } from "../src/agent-task/trace-projection/projection-tee.ts";
import type { AgentTaskTraceContext } from "../src/agent-task/tracing.ts";

interface RecordedCreate {
  issuedId: string;
  observationType?: string;
  model?: string;
}

interface RecordedEnd {
  receivedId: string;
  promptTokens?: number;
  completionTokens?: number;
}

/** A real-ish context that records createSpan/endSpan so we can assert on them. */
function makeRecordingReal(): AgentTaskTraceContext & {
  creates: RecordedCreate[];
  ends: RecordedEnd[];
} {
  let counter = 0;
  const creates: RecordedCreate[] = [];
  const ends: RecordedEnd[] = [];
  const issued = new Set<string>();

  const ctx: AgentTaskTraceContext = {
    runId: "test-run",
    rootSpanId: "root",
    async step<T>(_opts: { step_name: string }, fn: (_spanId: string) => Promise<T>): Promise<T> {
      return fn("step-span");
    },
    recordEvent(): string {
      return "event-span";
    },
    endRoot(): void {},
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
    createSpan(options): string {
      counter += 1;
      // The real context returns a DIFFERENT id than anything the caller
      // fabricated — it derives the id from its own span store.
      const realId = `real-span-${counter}`;
      issued.add(realId);
      creates.push({
        issuedId: realId,
        observationType: options.observation_type,
        model: options.model ?? undefined,
      });
      return realId;
    },
    endSpan(spanId, params): void {
      ends.push({
        receivedId: spanId,
        promptTokens: params?.prompt_tokens,
        completionTokens: params?.completion_tokens,
      });
    },
  };

  return Object.assign(ctx, {
    creates,
    ends,
    /** True if an id was ever issued by this context's createSpan. */
    wasIssued(id: string): boolean {
      return issued.has(id);
    },
  } as { creates: RecordedCreate[]; ends: RecordedEnd[]; wasIssued(id: string): boolean });
}

describe("projection-tee real span id propagation", () => {
  it("endSpan receives an id that createSpan actually issued (not the tee's id)", () => {
    const real = makeRecordingReal();
    const tee = createProjectionTee(real);
    const teeId = tee.trace.createSpan({
      step_name: "generation",
      observation_type: "GENERATION",
      model: "gpt-4o",
    });

    // Sanity: the tee returns its own id, which is NOT a real id.
    expect(teeId).not.toBe(real.creates[0]!.issuedId);
    expect(real.creates).toHaveLength(1);
    expect(real.creates[0]!.issuedId).toBe("real-span-1");

    tee.trace.endSpan(teeId, { prompt_tokens: 100, completion_tokens: 50 });

    // The bug: endSpan was called with teeId, which was never issued by real.
    // The fix: endSpan must be translated to the real id.
    expect(real.ends).toHaveLength(1);
    expect(real.wasIssued(real.ends[0]!.receivedId)).toBe(true);
  });

  it("token params reach the real context intact", () => {
    const real = makeRecordingReal();
    const tee = createProjectionTee(real);
    const teeId = tee.trace.createSpan({ step_name: "gen", observation_type: "GENERATION" });

    tee.trace.endSpan(teeId, { prompt_tokens: 1234, completion_tokens: 567 });

    expect(real.ends[0]!.promptTokens).toBe(1234);
    expect(real.ends[0]!.completionTokens).toBe(567);
  });

  it("endSpan is never called with a fabricated tee id that real never issued", () => {
    const real = makeRecordingReal();
    const tee = createProjectionTee(real);
    const teeId = tee.trace.createSpan({ step_name: "x" });

    tee.trace.endSpan(teeId, {});

    // The specific failure mode the bug caused: real.endSpan called with an id
    // that was never in real's span map. Every received id must be a real id.
    for (const end of real.ends) {
      expect(real.wasIssued(end.receivedId)).toBe(true);
    }
  });

  it("multiple spans each resolve to their own real id", () => {
    const real = makeRecordingReal();
    const tee = createProjectionTee(real);

    const a = tee.trace.createSpan({ step_name: "a", observation_type: "GENERATION" });
    const b = tee.trace.createSpan({ step_name: "b", observation_type: "GENERATION" });

    tee.trace.endSpan(a, { prompt_tokens: 10 });
    tee.trace.endSpan(b, { prompt_tokens: 20 });

    expect(real.creates.map((c) => c.issuedId)).toEqual(["real-span-1", "real-span-2"]);
    // Each end maps to a distinct real id (no aliasing).
    expect(real.ends[0]!.receivedId).toBe("real-span-1");
    expect(real.ends[1]!.receivedId).toBe("real-span-2");
    expect(real.ends[0]!.receivedId).not.toBe(real.ends[1]!.receivedId);
  });
});
