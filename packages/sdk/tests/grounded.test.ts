import { afterEach, describe, expect, it, vi } from "vitest";
import { createTraceTestContext } from "../src/agent-task/checks/t.ts";
import { GROUNDEDNESS_RUBRIC } from "../src/agent-task/checks/grounded.ts";
import { Recorder } from "../src/agent-task/checks/recorder.ts";
import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import type {
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "../src/agent-task/trace-projection/types.ts";

const judgeConfig = { model: "test/judge", baseURL: "https://judge.test/v1", apiKey: "secret" };

const VACATION = retrieval("r1", "how many vacation days", [
  { id: "handbook-vacation#p3", content: "Full-time employees receive 25 days of paid vacation." },
  { id: "handbook-faq", content: "Unused days do not carry over." },
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("t.grounded", () => {
  it("judges the answer against the documents this run retrieved", async () => {
    const requests = stubJudge({ pass: true, reasoning: "every claim is in source 1" });
    const rec = await run([VACATION], (t) => t.grounded("You get 25 days of paid vacation."));

    expect(rec.all[0]).toMatchObject({ id: "grounded", pass: true, evaluator_type: "llm" });
    const prompt = requests.join("\n");
    expect(prompt).toContain("Value 1 is an answer");
    expect(prompt).toContain("You get 25 days of paid vacation.");
    expect(prompt).toContain("[1] handbook-vacation#p3");
    expect(prompt).toContain("Unused days do not carry over.");
  });

  it("fails when the judge finds an unsupported claim", async () => {
    stubJudge({ pass: false, reasoning: "carry-over is not in any source" });
    const rec = await run([VACATION], (t) => t.grounded("Unused days carry over to next year."));
    expect(rec.all[0]).toMatchObject({ pass: false });
  });

  it("passes under expect fail when the judge catches a known hallucination", async () => {
    stubJudge({ pass: false, reasoning: "carry-over is not in any source" });
    const rec = await run([VACATION], (t) =>
      t.grounded("Unused days carry over.", { expect: "fail", label: "catches invented carry-over" }),
    );
    expect(rec.all[0]).toMatchObject({ id: "catches invented carry-over", pass: true });
  });

  it("is unsupported without retrieval evidence and never calls the judge", async () => {
    const requests = stubJudge({ pass: true, reasoning: "" });
    const rec = await run([], (t) => t.grounded("You get 25 days."));
    expect(rec.all[0]).toMatchObject({ id: "grounded", pass: false, outcome: "unsupported" });
    expect(requests).toHaveLength(0);
  });

  it("is unsupported when a retrieval's documents are unknown", async () => {
    const requests = stubJudge({ pass: true, reasoning: "" });
    const opaque: TraceProjectionObservation = { ...VACATION, spanId: "r2", output: { hits: 2 } };
    const rec = await run([VACATION, opaque], (t) => t.grounded("You get 25 days."));
    expect(rec.all[0]).toMatchObject({ pass: false, outcome: "unsupported" });
    expect(requests).toHaveLength(0);
  });

  it("judges against author-supplied sources without retrieval evidence", async () => {
    const requests = stubJudge({ pass: true, reasoning: "supported" });
    const rec = await run([], (t) =>
      t.grounded("Payday is the 25th.", { sources: ["Salaries are paid on the 25th of each month."] }),
    );
    expect(rec.all[0]).toMatchObject({ pass: true });
    expect(requests.join("\n")).toContain("Salaries are paid on the 25th of each month.");
  });

  it("states the source-not-world rule in the rubric", () => {
    expect(GROUNDEDNESS_RUBRIC).toContain("even if it is true in the real world");
  });
});

async function run(
  observations: TraceProjectionObservation[],
  checks: (t: ReturnType<typeof createTraceTestContext>) => Promise<void>,
): Promise<Recorder> {
  const rec = new Recorder();
  const retrieval = observations.some((o) => o.type === "RETRIEVER") ? { retrieval: "available" as const } : {};
  const snapshot: TraceProjectionSnapshot = {
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
      ...retrieval,
    },
    observations,
  };
  await checks(createTraceTestContext(new TraceView(snapshot), rec, judgeConfig));
  return rec;
}

/** Stub the judge's OpenAI-compatible endpoint; returns the raw request bodies it received. */
function stubJudge(verdict: { pass: boolean; reasoning: string }): string[] {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      requests.push(String(init?.body ?? ""));
      return Response.json({ choices: [{ message: { content: JSON.stringify(verdict) } }] });
    }),
  );
  return requests;
}

function retrieval(
  spanId: string,
  query: string,
  documents: { id?: string; content: string }[],
): TraceProjectionObservation {
  return {
    spanId,
    type: "RETRIEVER",
    name: "retrieve",
    status: "ok",
    startedAt: "2026-01-01T00:00:01.000Z",
    input: { query },
    output: { documents },
  };
}
