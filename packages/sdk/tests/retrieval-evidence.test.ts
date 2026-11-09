import { describe, it, expect } from "vitest";
import { createProjectionTee } from "../src/agent-task/trace-projection/projection-tee.ts";
import { parseRetrievedDocuments } from "../src/agent-task/trace-projection/retrieval.ts";
import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import type {
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "../src/agent-task/trace-projection/types.ts";
import { createNoopAgentTaskTraceContext } from "../src/agent-task/tracing.ts";

describe("parseRetrievedDocuments", () => {
  it("reads a { documents } wrapper with OpenInference names", () => {
    expect(
      parseRetrievedDocuments({ documents: [{ id: "a", score: 0.9, content: "alpha" }] }),
    ).toEqual([{ id: "a", score: 0.9, content: "alpha" }]);
  });

  it("reads a bare array and maps text to content", () => {
    expect(parseRetrievedDocuments([{ id: "a", text: "alpha" }, "beta"])).toEqual([
      { id: "a", content: "alpha" },
      { content: "beta" },
    ]);
  });

  it("keeps id-only documents and drops items with nothing to match on", () => {
    expect(parseRetrievedDocuments([{ id: "a" }, {}, 42, ""])).toEqual([
      { id: "a", content: "" },
    ]);
  });

  it("drops non-finite scores", () => {
    expect(
      parseRetrievedDocuments([{ id: "a", content: "x", score: Number.NaN }]),
    ).toEqual([{ id: "a", content: "x" }]);
  });

  it("reports an empty result as zero documents, not unknown", () => {
    expect(parseRetrievedDocuments([])).toEqual([]);
  });

  it("returns undefined for shapes it does not recognize", () => {
    expect(parseRetrievedDocuments({ hits: [] })).toBeUndefined();
    expect(parseRetrievedDocuments("alpha")).toBeUndefined();
    expect(parseRetrievedDocuments(undefined)).toBeUndefined();
  });
});

describe("projection tee retrieval capture", () => {
  it("records the query and normalized documents, returning the caller's result untouched", async () => {
    const tee = createProjectionTee(createNoopAgentTaskTraceContext());
    const raw = [{ id: "handbook-vacation", score: 0.89, text: "25 days" }];
    const result = await tee.trace.traceRetriever("vacation days", async () => raw);
    expect(result, "caller gets its own result object").toBe(raw);

    const snapshot = tee.getSnapshot();
    expect(snapshot.capabilities.retrieval).toBe("available");
    expect(new TraceView(snapshot).retrievals).toMatchObject([
      {
        query: "vacation days",
        documents: [{ id: "handbook-vacation", score: 0.89, content: "25 days" }],
        status: "ok",
      },
    ]);
  });

  it("derives partial when retrievals return unrecognized shapes", async () => {
    const tee = createProjectionTee(createNoopAgentTaskTraceContext());
    await tee.trace.traceRetriever("q", async () => ({ hits: 3 }));
    const snapshot = tee.getSnapshot();
    expect(snapshot.capabilities.retrieval).toBe("partial");
    const [retrieval] = new TraceView(snapshot).retrievals;
    expect(retrieval?.documents, "opaque retrieval has unknown documents").toBeUndefined();
  });

  it("derives unavailable when no retrieval ran", () => {
    const tee = createProjectionTee(createNoopAgentTaskTraceContext());
    expect(tee.getSnapshot().capabilities.retrieval).toBe("unavailable");
  });

  it("records a failed retrieval as an error observation and rethrows", async () => {
    const tee = createProjectionTee(createNoopAgentTaskTraceContext());
    await expect(
      tee.trace.traceRetriever("q", async () => {
        throw new Error("index offline");
      }),
    ).rejects.toThrow("index offline");
    const [retrieval] = new TraceView(tee.getSnapshot()).retrievals;
    expect(retrieval?.status).toBe("error");
  });
});

describe("TraceView.retrievals", () => {
  it("reads a snapshot written before retrieval was projected as unavailable", () => {
    expect(new TraceView(snapshotOf([])).requireCapability("retrieval")).toBe("unavailable");
  });

  it("orders retrievals by invocation time and parses raw canonical outputs", () => {
    const view = new TraceView(
      snapshotOf([
        retrieverObs("late", "2026-01-01T00:00:02.000Z", { query: "second" }, ["b"]),
        retrieverObs("early", "2026-01-01T00:00:01.000Z", { query: "first" }, [
          { id: "a", content: "alpha" },
        ]),
      ]),
    );
    expect(view.retrievals.map((r) => r.query)).toEqual(["first", "second"]);
    expect(view.retrievals[1]?.documents).toEqual([{ content: "b" }]);
  });

  it("reads canonical observations whose query and documents ride the tool channels", () => {
    const canonical: TraceProjectionObservation = {
      spanId: "c1",
      type: "RETRIEVER",
      name: "retrieve",
      status: "ok",
      toolParameters: { query: "vacation days" },
      toolResult: { documents: [{ id: "handbook-vacation#p1", score: 0.9, content: "25 days" }] },
    };
    expect(new TraceView(snapshotOf([canonical])).retrievals).toEqual([
      {
        spanId: "c1",
        status: "ok",
        query: "vacation days",
        documents: [{ id: "handbook-vacation#p1", score: 0.9, content: "25 days" }],
      },
    ]);
  });
});

function snapshotOf(observations: TraceProjectionObservation[]): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: { traceId: "trace-1", complete: true },
    capabilities: {
      messages: "available",
      tools: "available",
      errors: "available",
      timing: "available",
      skills: "available",
      subagents: "available",
    },
    observations,
  };
}

function retrieverObs(
  spanId: string,
  startedAt: string,
  input: unknown,
  output: unknown,
): TraceProjectionObservation {
  return { spanId, type: "RETRIEVER", name: "retrieve", status: "ok", startedAt, input, output };
}
