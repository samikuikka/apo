import { describe, expect, it } from "vitest";
import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import type {
  TraceProjectionCapabilities,
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "../src/agent-task/trace-projection/types.ts";
import { createTraceTestContext } from "../src/agent-task/checks/t.ts";
import { Recorder } from "../src/agent-task/checks/recorder.ts";

/**
 * `t.noModelDrift()` — strict serving integrity. The check reads each agent
 * generation's served model (`gen_ai.response.model`, captured on the
 * observation) and fails when it diverges from the requested model: a
 * gateway fallback swapped the serving model mid-run.
 */

function allAvailable(): TraceProjectionCapabilities {
  return {
    messages: "available",
    tools: "available",
    errors: "available",
    timing: "available",
    skills: "available",
    subagents: "available",
  };
}

function snapshot(
  observations: TraceProjectionObservation[],
): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "local",
    trace: { traceId: "t1", complete: true },
    capabilities: allAvailable(),
    observations,
  };
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `root-${String(idCounter).padStart(6, "0")}`;
}

let clock = 0;
function nextTs(): string {
  clock += 1;
  return `1970-01-01T00:00:${String(clock).padStart(2, "0")}.000Z`;
}

function genObs(overrides: Partial<TraceProjectionObservation> = {}): TraceProjectionObservation {
  return {
    spanId: nextId(),
    type: "GENERATION",
    name: "agent.generate",
    startedAt: nextTs(),
    endedAt: nextTs(),
    status: "ok",
    model: "deepseek/deepseek-v4.1-flash",
    ...overrides,
  };
}

function makeT(observations: TraceProjectionObservation[]) {
  const view = new TraceView(snapshot(observations));
  const rec = new Recorder();
  const t = createTraceTestContext(view, rec);
  return { view, rec, t };
}

function resetFixture(): void {
  idCounter = 0;
  clock = 0;
}

describe("t.noModelDrift()", () => {
  it("passes when every reported generation was served by its requested model", () => {
    resetFixture();
    const { rec, t } = makeT([
      genObs({ servedModel: "deepseek/deepseek-v4.1-flash" }),
      genObs({ servedModel: "deepseek/deepseek-v4.1-flash" }),
    ]);
    t.noModelDrift();
    expect(rec.all).toHaveLength(1);
    expect(rec.all[0]?.pass).toBe(true);
    expect(rec.all[0]?.id).toBe("noModelDrift");
  });

  it("fails listing the divergent served models when a gateway fell back", () => {
    resetFixture();
    const { rec, t } = makeT([
      genObs({ servedModel: "deepseek/deepseek-v4.1-flash" }),
      genObs({ servedModel: "openai/gpt-4o-mini" }),
      genObs({ servedModel: "openai/gpt-4o-mini" }),
    ]);
    t.noModelDrift();
    expect(rec.all[0]?.pass).toBe(false);
    expect(rec.all[0]?.reasoning).toContain(
      "2 generation(s) served by a different model than requested",
    );
    expect(rec.all[0]?.reasoning).toContain("openai/gpt-4o-mini ×2");
    expect(rec.all[0]?.reasoning).toContain(
      "requested deepseek/deepseek-v4.1-flash",
    );
  });

  it("fails closed when no generation reported the model that served it", () => {
    resetFixture();
    const { rec, t } = makeT([genObs({}), genObs({})]);
    t.noModelDrift();
    expect(rec.all[0]?.pass).toBe(false);
    expect(rec.all[0]?.reasoning).toMatch(/unverifiable/);
  });

  it("excludes judge generations — the judge runs on its own model", () => {
    resetFixture();
    const { rec, t } = makeT([
      genObs({ servedModel: "deepseek/deepseek-v4.1-flash" }),
      genObs({
        name: "judge:tone-check",
        model: "judge-primary",
        servedModel: "judge-fallback",
      }),
    ]);
    t.noModelDrift();
    // The judge's fallback does not read as the agent drifting, and the
    // agent generation is verified — pass.
    expect(rec.all[0]?.pass).toBe(true);
  });

  it("judge-only drift is unverifiable only when nothing reported — a judge report alone verifies nothing about the agent", () => {
    resetFixture();
    const { view } = makeT([
      genObs({ name: "judge:tone", model: "judge-primary", servedModel: "judge-fallback" }),
      genObs({}),
    ]);
    // servedModelGenerations excludes judges, so one unreported agent
    // generation leaves the claim unverifiable.
    expect(view.servedModelGenerations).toHaveLength(0);
    expect(view.modelDrift).toHaveLength(0);
  });
});
