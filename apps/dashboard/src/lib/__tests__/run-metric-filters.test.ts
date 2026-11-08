import { describe, expect, it } from "vitest";

import {
  COST_PRESETS,
  DURATION_PRESETS,
  EMPTY_METRIC_FILTERS,
  isMetricFilterActive,
  metricChips,
  metricFilterParams,
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

  it("drops missing, empty, negative, and non-numeric bounds", () => {
    expect(parseMetricFilters({ cost_min: "", cost_max: "abc", duration_min: "-5" })).toEqual(
      EMPTY_METRIC_FILTERS,
    );
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
      { metric: "Cost", text: "$0.1 to 0.5" },
      { metric: "Duration", text: "over 5 min" },
    ]);
    expect(metricChips(EMPTY_METRIC_FILTERS)).toEqual([]);
  });

  it("presets cover their range without gaps or overlaps", () => {
    expect(COST_PRESETS[0].max).toBe(COST_PRESETS[1].min);
    expect(COST_PRESETS[1].max).toBe(COST_PRESETS[2].min);
    expect(DURATION_PRESETS[0].max).toBe(DURATION_PRESETS[1].min);
    expect(DURATION_PRESETS[1].max).toBe(DURATION_PRESETS[2].min);
  });
});
