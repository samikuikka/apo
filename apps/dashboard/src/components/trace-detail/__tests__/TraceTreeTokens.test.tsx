import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TraceObservation } from "../contexts";
import { SelectionProvider } from "../contexts/SelectionContext";
import { computeCumulativeMetrics } from "@/lib/cumulative-metrics";

const traceData = vi.hoisted(() => ({
  run: { run: { id: "trace-1", project: "proj" } } as unknown,
  cumulativeMetrics: new Map(),
  prefetchObservation: () => {},
  isSimplifiedTree: false,
}));

vi.mock("../contexts/TraceDataContext", () => ({
  useTraceData: () => traceData,
}));

vi.mock("../contexts/ViewPreferencesContext", () => ({
  useViewPreferences: () => ({
    preferences: {
      showDuration: false,
      showCostTokens: true,
      showScores: false,
      showComments: false,
      colorCodeMetrics: false,
      minObservationLevel: "DEFAULT",
    },
  }),
}));

// jsdom has no layout, so the real virtualizer renders no rows: render them all.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 37 })),
    getTotalSize: () => count * 37,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

import { TraceTree } from "../TraceTree";

function call(id: string, parent: string | null, at: number, extra: Partial<TraceObservation> = {}): TraceObservation {
  return {
    id,
    step_name: id,
    parent_call_id: parent,
    step_index: null,
    created_at: new Date(Date.UTC(2026, 9, 30, 10, 0, at)).toISOString(),
    latency_ms: 100,
    model: "unknown",
    input: null,
    output: null,
    task_id: null,
    observation_type: "SPAN",
    ...extra,
  } as TraceObservation;
}

const calls = [
  call("turn", null, 0),
  call("gen-a", "turn", 1, {
    observation_type: "GENERATION",
    prompt_tokens: 17_655,
    completion_tokens: 226,
    total_tokens: 17_881,
    raw_usage: { input: 4, cache_read: 0, cache_write_5m: 17_651 },
  }),
  call("gen-b", "turn", 2, {
    observation_type: "GENERATION",
    prompt_tokens: 25_731,
    completion_tokens: 393,
    total_tokens: 26_124,
    raw_usage: { input: 2, cache_read: 17_651, cache_write_5m: 6_000, cache_write_1h: 2_078 },
  }),
  // A provider that reported only a total: no input → output split to show.
  call("gen-c", "turn", 3, {
    observation_type: "GENERATION",
    prompt_tokens: 30_000,
    total_tokens: 30_000,
    raw_usage: { input: 1_000, cache_read: 29_000 },
  }),
];

describe("TraceTree token labels", () => {
  it("names the cached share on parent rows from descendants and on leaves from the call", () => {
    traceData.cumulativeMetrics = computeCumulativeMetrics(calls);
    render(
      <SelectionProvider>
        <TraceTree calls={calls} searchQuery="" />
      </SelectionProvider>,
    );

    const parent = screen.getByText("73.4k (46.7k cached)→619 tok");
    expect(parent.getAttribute("title")).toBe(
      "Input 73.4k: 46.7k read from cache, 25.7k written to cache, 1.0k uncached",
    );
    const written = screen.getByText("17.7k→226 tok");
    expect(written.getAttribute("title")).toBe(
      "Input 17.7k: 0 read from cache, 17.7k written to cache, 4 uncached",
    );
    expect(screen.getByText("25.7k (17.7k cached)→393 tok")).toBeTruthy();
    expect(screen.getByText("30.0k tok (29.0k cached)")).toBeTruthy();
  });
});
