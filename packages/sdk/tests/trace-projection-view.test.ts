import { describe, it, expect } from "vitest";
import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import type {
  TraceProjectionSnapshot,
  TraceProjectionObservation,
  TraceProjectionCapabilities,
  EvidenceAvailability,
} from "../src/agent-task/trace-projection/types.ts";

/** Capabilities shortcut for fixtures: everything available unless overridden. */
function allAvailable(
  overrides: Partial<TraceProjectionCapabilities> = {},
): TraceProjectionCapabilities {
  return {
    messages: "available",
    tools: "available",
    errors: "available",
    timing: "available",
    skills: "available",
    subagents: "available",
    ...overrides,
  };
}

function snapshot(
  observations: TraceProjectionObservation[],
  opts: {
    capabilities?: TraceProjectionCapabilities;
    startedAt?: string;
    endedAt?: string;
    complete?: boolean;
  } = {},
): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: {
      traceId: "trace-1",
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      complete: opts.complete ?? false,
    },
    capabilities: opts.capabilities ?? allAvailable(),
    observations,
  };
}

function toolObs(
  name: string,
  extra: Partial<TraceProjectionObservation> = {},
): TraceProjectionObservation {
  return {
    spanId: extra.spanId ?? `span-${name}`,
    type: "TOOL",
    name,
    status: "unset",
    ...extra,
  };
}

describe("TraceView", () => {
  describe("requireCapability", () => {
    it("returns the evidence availability for a capability", () => {
      const view = new TraceView(snapshot([], { capabilities: allAvailable({ timing: "partial" }) }));
      expect(view.requireCapability("timing")).toBe("partial");
      expect(view.requireCapability("tools")).toBe("available");
    });
  });

  describe("toolNamesInOrder — uses invocation time, not completion/array order (Test 4)", () => {
    it("orders by startedAt regardless of array position", () => {
      // Tool A starts first but ends after tool B. Flow (completion order)
      // would give B, A; the projection must give A, B by invocation time.
      const observations = [
        toolObs("A", { spanId: "a", startedAt: "2026-07-10T10:00:00Z", endedAt: "2026-07-10T10:00:10Z" }),
        toolObs("B", { spanId: "b", startedAt: "2026-07-10T10:00:01Z", endedAt: "2026-07-10T10:00:02Z" }),
      ];
      // Deliberately place B first in the array to prove we don't use array order.
      const reversed = new TraceView(snapshot([observations[1]!, observations[0]!]));
      expect(reversed.toolNamesInOrder).toEqual(["A", "B"]);
    });
  });

  describe("toolNamesInOrder — span-ID tie-breaker (Test 5)", () => {
    it("stably orders equal/missing start times by span ID", () => {
      const observations = [
        toolObs("Zeta", { spanId: "span-z" }), // no startedAt
        toolObs("Alpha", { spanId: "span-a" }), // no startedAt
        toolObs("Mid", { spanId: "span-m" }),
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.toolNamesInOrder).toEqual(["Alpha", "Mid", "Zeta"]);
    });

    it("orders timestamped observations before untimestamped ones", () => {
      const observations = [
        toolObs("Untimed", { spanId: "span-aaa" }),
        toolObs("Timed", { spanId: "span-zzz", startedAt: "2026-07-10T10:00:00Z" }),
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.toolNamesInOrder).toEqual(["Timed", "Untimed"]);
    });

    it("produces stable order across repeated constructions", () => {
      const observations = [
        toolObs("C", { spanId: "c" }),
        toolObs("A", { spanId: "a" }),
        toolObs("B", { spanId: "b" }),
      ];
      const first = new TraceView(snapshot(observations)).toolNamesInOrder;
      const second = new TraceView(snapshot(observations)).toolNamesInOrder;
      expect(first).toEqual(["A", "B", "C"]);
      expect(second).toEqual(first);
    });
  });

  describe("capability honesty — unavailable evidence yields undefined, not zero (Test 6)", () => {
    it("durationMs is undefined when timing is unavailable", () => {
      const view = new TraceView(
        snapshot(
          [],
          { capabilities: allAvailable({ timing: "unavailable" }), startedAt: "2026-07-10T10:00:00Z", endedAt: "2026-07-10T10:00:05Z" },
        ),
      );
      expect(view.durationMs).toBeUndefined();
    });

    it("failedActions is undefined when errors is unavailable", () => {
      const observations = [
        toolObs("failing", { status: "error", spanId: "f1" }),
      ];
      const view = new TraceView(snapshot(observations, { capabilities: allAvailable({ errors: "unavailable" }) }));
      expect(view.failedActions).toBeUndefined();
    });

    it("turnCount is undefined when messages is unavailable", () => {
      const view = new TraceView(
        snapshot([], { capabilities: allAvailable({ messages: "unavailable" }) }),
      );
      expect(view.turnCount).toBeUndefined();
    });
  });

  describe("derived facts when capability IS available", () => {
    it("durationMs uses trace startedAt/endedAt", () => {
      const view = new TraceView(
        snapshot([], { startedAt: "2026-07-10T10:00:00Z", endedAt: "2026-07-10T10:00:04Z" }),
      );
      expect(view.durationMs).toBe(4000);
    });

    it("failedActions counts error-status tool/subagent observations", () => {
      const observations = [
        toolObs("ok1", { spanId: "o1", status: "ok" }),
        toolObs("err1", { spanId: "e1", status: "error" }),
        { ...toolObs("agent-err", { spanId: "e2" }), type: "AGENT" as const, name: "agent-err", status: "error" as const },
        { ...toolObs("agent-ok", { spanId: "o2" }), type: "AGENT" as const, name: "agent-ok", status: "ok" as const },
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.failedActions).toBe(2);
    });

    it("turnCount counts assistant messages", () => {
      const observations: TraceProjectionObservation[] = [
        {
          spanId: "g1", type: "GENERATION", name: "gen", status: "unset",
          messages: [{ role: "user", content: "hi" }],
        },
        {
          spanId: "g2", type: "GENERATION", name: "gen", status: "unset",
          messages: [{ role: "assistant", content: "hello" }],
        },
        {
          spanId: "g3", type: "GENERATION", name: "gen", status: "unset",
          messages: [{ role: "assistant", content: "how are you" }],
        },
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.turnCount).toBe(2);
    });
  });

  describe("unknown spans survive as SPAN (Test 7)", () => {
    it("a generic SPAN observation is preserved in toolCalls? no — it is not a tool, but it survives in observations", () => {
      const observations: TraceProjectionObservation[] = [
        { spanId: "s1", type: "SPAN", name: "some-housekeeping", status: "unset" },
        toolObs("read_file", { spanId: "t1" }),
      ];
      const view = new TraceView(snapshot(observations));
      // The SPAN is not a tool call...
      expect(view.toolCalls.map((c) => c.name)).toEqual(["read_file"]);
      // ...but the raw snapshot still contains it unchanged.
      expect(view.snapshot.observations.map((o) => o.type)).toEqual(["SPAN", "TOOL"]);
    });
  });

  describe("reply", () => {
    it("returns the last assistant message content", () => {
      const observations: TraceProjectionObservation[] = [
        { spanId: "g1", type: "GENERATION", name: "gen", status: "unset", messages: [{ role: "user", content: "q" }] },
        { spanId: "g2", type: "GENERATION", name: "gen", status: "unset", messages: [{ role: "assistant", content: "first" }] },
        { spanId: "g3", type: "GENERATION", name: "gen", status: "unset", messages: [{ role: "assistant", content: "final" }] },
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.reply).toBe("final");
    });

    it("returns empty string when no assistant messages", () => {
      const view = new TraceView(snapshot([]));
      expect(view.reply).toBe("");
    });
  });

  describe("messages", () => {
    it("flattens messages across generation observations in order", () => {
      const observations: TraceProjectionObservation[] = [
        { spanId: "g1", type: "GENERATION", name: "gen", status: "unset", messages: [{ role: "user", content: "a" }] },
        { spanId: "g2", type: "GENERATION", name: "gen", status: "unset", messages: [{ role: "assistant", content: "b" }] },
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.messages.map((m) => m.content)).toEqual(["a", "b"]);
    });
  });

  describe("skillLoads and subagentCalls", () => {
    it("filters SKILL and AGENT observations respectively", () => {
      const observations: TraceProjectionObservation[] = [
        { spanId: "sk1", type: "SKILL", name: "code-review", status: "unset" },
        { spanId: "ag1", type: "AGENT", name: "researcher", status: "unset" },
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.skillLoads.map((s) => s.skill)).toEqual(["code-review"]);
      expect(view.subagentCalls.map((s) => s.agent)).toEqual(["researcher"]);
    });
  });

  describe("serving evidence (issue #307): additive transport fields", () => {
    it("consumes an old snapshot without serving/rates/requestAccounting unchanged", () => {
      // A pre-feature fixture: no serving, rates, or requestAccounting keys
      // anywhere. Deserialization and every existing getter must behave
      // exactly as before.
      const observations: TraceProjectionObservation[] = [
        toolObs("read_file", {
          spanId: "t1",
          startedAt: "2026-07-10T10:00:00Z",
          usage: { inputTokens: 10, outputTokens: 4 },
        }),
        {
          spanId: "g1",
          type: "GENERATION",
          name: "gen",
          status: "ok",
          usage: { inputTokens: 100, outputTokens: 40 },
        },
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.toolNamesInOrder).toEqual(["read_file"]);
      expect(view.snapshot.observations[1]).not.toHaveProperty("serving");
      expect(view.snapshot.observations[1]).not.toHaveProperty("rates");
      expect(view.snapshot.observations[1]).not.toHaveProperty("requestAccounting");
    });

    it("preserves serving, rates, and requestAccounting through the view untouched", () => {
      const observations: TraceProjectionObservation[] = [
        {
          spanId: "g1",
          type: "GENERATION",
          name: "gen",
          status: "ok",
          serving: {
            apiProvider: "openrouter",
            servingHost: "baseten",
            route: "nitro",
            serviceTier: "priority",
          },
          rates: {
            timeToFirstTokenMs: 500,
            wholeCallOutputTokensPerSecond: 50,
            outputTokenScope: "all_output",
          },
          requestAccounting: "request",
        },
        {
          spanId: "g2",
          type: "GENERATION",
          name: "wrapper",
          status: "ok",
          serving: { apiProvider: "fireworks" },
          rates: { streamingUnavailableReason: "aggregate_only", outputTokenScope: "unknown" },
          requestAccounting: "aggregate",
        },
      ];
      const view = new TraceView(snapshot(observations));
      expect(view.snapshot.observations[0]?.serving).toEqual({
        apiProvider: "openrouter",
        servingHost: "baseten",
        route: "nitro",
        serviceTier: "priority",
      });
      expect(view.snapshot.observations[0]?.rates?.wholeCallOutputTokensPerSecond).toBe(50);
      expect(view.snapshot.observations[0]?.requestAccounting).toBe("request");
      expect(view.snapshot.observations[1]?.requestAccounting).toBe("aggregate");
      // The new fields change no derived getter: usage still counts.
      expect(view.snapshot.observations[0]?.usage).toBeUndefined();
    });
  });
});

// Compile-time check that EvidenceAvailability import is used (test fixtures reference it).
const _ea: EvidenceAvailability = "available";
void _ea;
