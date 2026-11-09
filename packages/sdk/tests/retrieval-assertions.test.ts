import { describe, it, expect } from "vitest";
import { createTraceTestContext } from "../src/agent-task/checks/t.ts";
import { Recorder } from "../src/agent-task/checks/recorder.ts";
import { equals } from "../src/agent-task/checks/matchers.ts";
import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import type {
  EvidenceAvailability,
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "../src/agent-task/trace-projection/types.ts";

const HANDBOOK = retrieval("r1", "how many vacation days", [
  { id: "handbook-onboarding", score: 0.91, content: "New employees accrue vacation monthly." },
  { id: "handbook-faq", score: 0.84, content: "See the leave policy." },
  { id: "handbook-vacation#p3", score: 0.8, content: "Full-time employees receive 25 days." },
]);

describe("t.retrieved", () => {
  it("passes on an exact id and on a chunk of that id", () => {
    const rec = run([HANDBOOK], (t) => {
      t.retrieved("handbook-faq");
      t.retrieved("handbook-vacation");
    });
    expect(rec.all.map((r) => r.pass)).toEqual([true, true]);
    expect(rec.all[1]?.received).toBe('rank 3 for query "how many vacation days"');
  });

  it("does not treat a longer id with the same prefix as a chunk", () => {
    const rec = run([HANDBOOK], (t) => t.retrieved("handbook"));
    expect(rec.all[0]?.pass).toBe(false);
  });

  it("matches by idPrefix and by contentIncludes", () => {
    const rec = run([HANDBOOK], (t) => {
      t.retrieved({ idPrefix: "handbook-vac" });
      t.retrieved({ contentIncludes: "25 days" });
      t.retrieved({ id: "handbook-vacation" });
    });
    expect(rec.all.map((r) => r.pass)).toEqual([true, true, false]);
  });

  it("enforces topK against the retriever's rank order", () => {
    const rec = run([HANDBOOK], (t) => {
      t.retrieved("handbook-vacation", { topK: 2 });
      t.retrieved("handbook-vacation", { topK: 3 });
    });
    expect(rec.all.map((r) => r.pass)).toEqual([false, true]);
    expect(rec.all[0]?.id).toBe('retrieved("handbook-vacation" in top 2)');
  });

  it("rejects a topK that is not a positive integer", () => {
    expect(() => run([HANDBOOK], (t) => t.retrieved("x", { topK: 0 }))).toThrow(TypeError);
  });

  it("scopes to retrievals whose query contains the text", () => {
    const other = retrieval("r2", "payroll dates", [{ id: "payroll-calendar", content: "Paid monthly." }]);
    const rec = run([HANDBOOK, other], (t) => {
      t.retrieved("payroll-calendar", { query: "payroll" });
      t.retrieved("payroll-calendar", { query: "vacation" });
    });
    expect(rec.all.map((r) => r.pass)).toEqual([true, false]);
  });

  it("shows what was retrieved when the document is missing", () => {
    const rec = run([HANDBOOK], (t) => t.retrieved("handbook-sick-leave"));
    expect(rec.all[0]?.received).toBe(
      '"how many vacation days": [handbook-onboarding, handbook-faq, handbook-vacation#p3]',
    );
  });

  it("is unsupported when the snapshot carries no retrieval evidence", () => {
    const rec = run([], (t) => t.retrieved("handbook-faq"));
    expect(rec.all[0]).toMatchObject({ pass: false, outcome: "unsupported" });
  });

  it("is unsupported when an in-scope retrieval returned an unrecognized shape", () => {
    const opaque: TraceProjectionObservation = { ...HANDBOOK, spanId: "r2", output: { hits: 3 } };
    const rec = run([HANDBOOK, opaque], (t) => t.retrieved("handbook-sick-leave"));
    expect(rec.all[0]).toMatchObject({ pass: false, outcome: "unsupported" });
  });
});

describe("t.not", () => {
  it("passes when the document was not retrieved and fails when it was", () => {
    const rec = run([HANDBOOK], (t) => {
      t.not.retrieved("acme-payroll");
      t.not.retrieved("handbook-faq");
    });
    expect(rec.all.map((r) => [r.id, r.pass])).toEqual([
      ['not.retrieved("acme-payroll")', true],
      ['not.retrieved("handbook-faq")', false],
    ]);
    expect(rec.all[1]?.reasoning).toBe('expected retrieved("handbook-faq") not to hold, but it did');
    expect(rec.all[1]?.expected).toBe('not "handbook-faq" retrieved');
  });

  it("never turns missing retrieval evidence into a pass", () => {
    const rec = run([], (t) => t.not.retrieved("acme-payroll"));
    expect(rec.all[0]).toMatchObject({
      id: 'not.retrieved("acme-payroll")',
      pass: false,
      outcome: "unsupported",
    });
  });

  it("never turns an unrecognized retrieval into proof of absence", () => {
    const opaque: TraceProjectionObservation = { ...HANDBOOK, spanId: "r2", output: { hits: 3 } };
    const rec = run([HANDBOOK, opaque], (t) => t.not.retrieved("acme-payroll"));
    expect(rec.all[0]).toMatchObject({ pass: false, outcome: "unsupported" });
  });

  it("negates tool and value assertions the same way", () => {
    const tool: TraceProjectionObservation = { spanId: "t1", type: "TOOL", name: "delete_user", status: "ok" };
    const rec = run([HANDBOOK, tool], (t) => {
      t.not.calledTool("delete_user");
      t.not.check(3, equals(4), "count");
    });
    expect(rec.all.map((r) => [r.id, r.pass])).toEqual([
      ['not.calledTool("delete_user")', false],
      ["not.count", true],
    ]);
  });

  it("does not leak negation into the next assertion", () => {
    const rec = run([HANDBOOK], (t) => {
      t.not.retrieved("acme-payroll");
      t.retrieved("handbook-faq");
    });
    expect(rec.all.map((r) => [r.id, r.pass])).toEqual([
      ['not.retrieved("acme-payroll")', true],
      ['retrieved("handbook-faq")', true],
    ]);
  });
});

describe("t.maxRetrievals", () => {
  it("bounds how many retrievals ran", () => {
    const rec = run([HANDBOOK, { ...HANDBOOK, spanId: "r2" }], (t) => {
      t.maxRetrievals(2);
      t.maxRetrievals(1);
    });
    expect(rec.all.map((r) => r.pass)).toEqual([true, false]);
  });

  it("counts retrievals even when their documents are unrecognized", () => {
    const opaque: TraceProjectionObservation = { ...HANDBOOK, output: { hits: 3 } };
    const rec = run([opaque, { ...opaque, spanId: "r2" }], (t) => t.maxRetrievals(1), "partial");
    expect(rec.all[0]).toMatchObject({ pass: false, received: "2" });
  });

  it("is unsupported without retrieval evidence", () => {
    const rec = run([], (t) => t.maxRetrievals(3));
    expect(rec.all[0]).toMatchObject({ pass: false, outcome: "unsupported" });
  });
});

function run(
  observations: TraceProjectionObservation[],
  checks: (t: ReturnType<typeof createTraceTestContext>) => void,
  retrievalCapability?: EvidenceAvailability,
): Recorder {
  const rec = new Recorder();
  const capability =
    retrievalCapability ?? (observations.some((o) => o.type === "RETRIEVER") ? "available" : undefined);
  checks(createTraceTestContext(new TraceView(snapshotOf(observations, capability)), rec));
  return rec;
}

function snapshotOf(
  observations: TraceProjectionObservation[],
  retrieval: EvidenceAvailability | undefined,
): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "local",
    trace: { traceId: "trace-1", complete: true },
    capabilities: {
      messages: "available",
      tools: "available",
      errors: "available",
      timing: "available",
      skills: "available",
      subagents: "available",
      ...(retrieval === undefined ? {} : { retrieval }),
    },
    observations,
  };
}

function retrieval(
  spanId: string,
  query: string,
  documents: { id?: string; score?: number; content: string }[],
): TraceProjectionObservation {
  return {
    spanId,
    type: "RETRIEVER",
    name: "retrieve",
    status: "ok",
    startedAt: `2026-01-01T00:00:0${spanId.slice(-1)}.000Z`,
    input: { query },
    output: { documents },
  };
}
