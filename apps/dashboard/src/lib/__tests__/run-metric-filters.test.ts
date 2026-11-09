import { describe, expect, it } from "vitest";

import {
  EMPTY_METRIC_FILTERS,
  isMetricFilterActive,
  metricChips,
  metricFilterParams,
  metricPresets,
  parseMetricFilters,
} from "../run-metric-filters";

describe("run metric filters", () => {
  it("reads the API's own param names from either kind of search params", () => {
    const fromUrl = parseMetricFilters(
      new URLSearchParams("cost_min=0.1&cost_max=0.5&duration_min=60&duration_max=300"),
    );
    const fromPage = parseMetricFilters({
      cost_min: "0.1",
      cost_max: "0.5",
      duration_min: "60",
      duration_max: "300",
    });
    expect(fromUrl).toEqual(fromPage);
    expect(fromUrl).toEqual({
      cost: { min: 0.1, max: 0.5 },
      durationSeconds: { min: 60, max: 300 },
    });
  });

  it("drops missing, empty, whitespace, negative, and non-numeric bounds", () => {
    expect(
      parseMetricFilters({ cost_min: "", cost_max: "abc", duration_min: "-5", duration_max: "  " }),
    ).toEqual(EMPTY_METRIC_FILTERS);
  });

  it("round-trips parse through the URL params updateUrl writes", () => {
    const parsed = parseMetricFilters(new URLSearchParams("cost_max=0.5&duration_min=60"));
    expect(metricFilterParams(parsed)).toEqual({
      cost_min: null,
      cost_max: "0.5",
      duration_min: "60",
      duration_max: null,
    });
  });

  it("knows when a range is active", () => {
    expect(isMetricFilterActive(EMPTY_METRIC_FILTERS)).toBe(false);
    expect(isMetricFilterActive({ ...EMPTY_METRIC_FILTERS, cost: { min: null, max: 0.5 } })).toBe(
      true,
    );
  });

  it("describes active ranges as chip text in dollars and minutes", () => {
    const chips = metricChips({
      cost: { min: 0.1, max: 0.5 },
      durationSeconds: { min: 300, max: null },
    });
    expect(chips).toEqual([
      { metric: "Cost", kind: "cost", text: "$0.1 to 0.5" },
      { metric: "Duration", kind: "duration", text: "over 5 min" },
    ]);
    expect(metricChips(EMPTY_METRIC_FILTERS)).toEqual([]);
  });

  it("builds presets from the project's own distribution", () => {
    const presets = metricPresets({ p20: 0.08, p50: 0.23, p80: 0.61 }, "cost");
    expect(presets).toEqual([
      { label: "Cheapest 20%", detail: "under $0.08", min: null, max: 0.08 },
      { label: "Typical", detail: "$0.08 to $0.61", min: 0.08, max: 0.61 },
      { label: "Costliest 20%", detail: "over $0.61", min: 0.61, max: null },
    ]);
    const durations = metricPresets({ p20: 30, p50: 90, p80: 300 }, "duration");
    expect(durations[0]).toMatchObject({
      label: "Fastest 20%",
      detail: "under 30 s",
      max: 30,
    });
    expect(durations[2]).toMatchObject({ label: "Slowest 20%", min: 300 });
  });

  it("yields no presets without quantiles or with a degenerate spread", () => {
    expect(metricPresets(undefined, "cost")).toEqual([]);
    expect(metricPresets(null, "duration")).toEqual([]);
    expect(metricPresets({ p20: 5, p50: 5, p80: 5 }, "cost")).toEqual([]);
  });
});
