import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { TraceDetailTabs } from "../TraceDetailTabs";
import { SelectionProvider } from "../contexts/SelectionContext";

function renderTabs(run: any) {
  return render(
    <SelectionProvider>
      <TraceDetailTabs run={run} />
    </SelectionProvider>,
  );
}

const BASE_RUN = {
  id: "run-1",
  project: "p1",
  input: null,
  output: null,
  created_at: "2026-01-01T00:00:00Z",
};

describe("TraceDetailTabs preview empty states", () => {
  it("shows the no-data message when trace and call I/O are all empty objects", () => {
    // Raw-OTel traces record `input: {}` on their spans; rendering those as an
    // empty JSON tree looks like a broken pane, so they count as absent.
    renderTabs({
      run: { ...BASE_RUN },
      calls: [
        { id: "c1", input: {}, output: {} },
        { id: "c2", input: {}, output: {} },
      ],
    });
    expect(screen.getByText("No input recorded for this trace.")).toBeTruthy();
    expect(screen.getByText("No output recorded for this trace.")).toBeTruthy();
  });

  it("falls back to the first call's payload when the trace has none", () => {
    renderTabs({
      run: { ...BASE_RUN },
      calls: [{ id: "c1", input: { query: "select 1" }, output: { rows: 3 } }],
    });
    expect(screen.queryByText("No input recorded for this trace.")).toBeNull();
    expect(screen.getByText("Query")).toBeTruthy();
    expect(screen.getByText("Rows")).toBeTruthy();
  });

  it("renders a recorded trace-level input and output as-is", () => {
    renderTabs({
      run: { ...BASE_RUN, input: { prompt: "hello" }, output: { answer: "hi" } },
      calls: [{ id: "c1", input: { ignored: true }, output: { ignored: true } }],
    });
    expect(screen.getByText("Prompt")).toBeTruthy();
    expect(screen.getByText("Answer")).toBeTruthy();
    expect(screen.queryByText("No input recorded for this trace.")).toBeNull();
    expect(screen.queryByText("No output recorded for this trace.")).toBeNull();
  });
});

// Issue #309: reasoning totals + timing extremes on the Tokens/Costs tabs.
// Unknown reasoning (no call reported the dimension) reads "not reported",
// never a false zero. Timing facts are GENERATION-only: the agent-task root
// span's latency is the run's whole wall clock and must never win
// "Slowest call" (the API always sends observation_type; fixtures mirror that).
describe("TraceDetailTabs reasoning and timing rollups", () => {
  it("sums reasoning from raw_usage and shows the unknown state", () => {
    renderTabs({
      run: { ...BASE_RUN },
      calls: [
        {
          id: "c1",
          input: {},
          output: {},
          observation_type: "GENERATION",
          latency_ms: 1_000,
          total_tokens: 50,
          raw_usage: { input: 40, output: 10, reasoning: 7_000 },
        },
        {
          id: "c2",
          input: {},
          output: {},
          observation_type: "GENERATION",
          latency_ms: 3_000,
          total_tokens: 30,
          raw_usage: { input: 20, output: 10, reasoning: 3_000 },
        },
        {
          id: "c3",
          input: {},
          output: {},
          observation_type: "GENERATION",
          latency_ms: 2_000,
          total_tokens: 30,
          raw_usage: { input: 20, output: 10 }, // no reasoning key
        },
      ],
    });

    // Radix only mounts the active tab — open Tokens, then Costs.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Tokens" }));

    // Tokens tab: total reasoning over reporting calls only (7,000 + 3,000),
    // the deepest call's 7,000 as the jump-to-observation control, plus the
    // partial note that one call did not report.
    expect(screen.getByText("Reasoning")).toBeTruthy();
    expect(screen.getByText("10,000")).toBeTruthy();
    expect(screen.getByText("7,000")).toBeTruthy();
    expect(screen.getByText("1 call(s) did not report reasoning")).toBeTruthy();
    expect(screen.getByText("Max single call")).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Costs" }));

    // Costs tab: model time + slowest call. Three generations: 1s + 3s + 2s
    // = 6.0s model time, 3.0s slowest — distinct texts, no ambiguity.
    expect(screen.getByText("Model time")).toBeTruthy();
    expect(screen.getByText("Slowest call")).toBeTruthy();
    expect(screen.getByText("3.0s")).toBeTruthy();
    expect(screen.getByText("6.0s")).toBeTruthy();
  });

  it("renders reasoning as not reported when no call sent the dimension", () => {
    renderTabs({
      run: { ...BASE_RUN },
      calls: [
        {
          id: "c1",
          input: {},
          output: {},
          observation_type: "GENERATION",
          latency_ms: 500,
          total_tokens: 10,
          raw_usage: { input: 5, output: 5 },
        },
      ],
    });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Tokens" }));

    expect(screen.getByText("Reasoning")).toBeTruthy();
    expect(screen.getByText("not reported")).toBeTruthy();
    expect(screen.queryByText("Max single call")).toBeNull();
  });

  it("never lets the agent-task root span or a tool win slowest call", () => {
    renderTabs({
      run: { ...BASE_RUN },
      calls: [
        {
          id: "root",
          input: {},
          output: {},
          observation_type: "SPAN",
          model: "agent-task",
          latency_ms: 600_000, // the run's whole wall clock
        },
        {
          id: "tool-1",
          input: {},
          output: {},
          observation_type: "TOOL",
          latency_ms: 120_000,
        },
        {
          id: "gen-1",
          input: {},
          output: {},
          observation_type: "GENERATION",
          latency_ms: 4_000,
          total_tokens: 10,
          raw_usage: { input: 5, output: 5 },
        },
        {
          id: "gen-2",
          input: {},
          output: {},
          observation_type: "GENERATION",
          latency_ms: 1_500,
          total_tokens: 10,
          raw_usage: { input: 5, output: 5 },
        },
      ],
    });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Costs" }));

    // The slowest MODEL call (4.0s), not the slowest observation; model time
    // sums generations only (5.5s); the average is over generations (2750ms).
    expect(screen.getByText("Slowest call")).toBeTruthy();
    expect(screen.getByText("4.0s")).toBeTruthy();
    expect(screen.getByText("5.5s")).toBeTruthy();
    expect(screen.getByText("2750ms")).toBeTruthy();
    // Neither the root span's nor the tool's latency may appear.
    expect(screen.queryByText("600.0s")).toBeNull();
    expect(screen.queryByText("120.0s")).toBeNull();
  });
});
