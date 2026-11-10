import { describe, expect, it } from "vitest";

import {
  EMPTY_METRIC_FILTERS,
  isMetricFilterActive,
  metricChips,
  metricFilterParams,
  loadSavedScopes,
  metricPresets,
  parseMetricFilters,
  railOwnedParams,
  savedScopePatch,
  saveSavedScopes,
} from "../run-metric-filters";

// Node 25's global localStorage lacks the Storage methods; stand in memory.
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

vi.stubGlobal("localStorage", new MemoryStorage());

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

describe("saved scopes", () => {
  it("keeps only the rail-owned params when saving", () => {
    const params = railOwnedParams(
      "?label=team:platforms&label=release:r42&environment=prod&cost_min=0.25&page=3&status=failed&q=x",
    );
    const kept = new URLSearchParams(params);
    expect(kept.getAll("label")).toEqual(["team:platforms", "release:r42"]);
    expect(kept.get("environment")).toBe("prod");
    expect(kept.get("cost_min")).toBe("0.25");
    expect(kept.get("page")).toBeNull();
    expect(kept.get("status")).toBeNull();
  });

  it("applies a saved scope with every repeated label intact", () => {
    const saved = railOwnedParams("?label=team:platforms&label=release:r42&environment=prod");
    const patch = savedScopePatch(saved);
    expect(patch).toEqual({
      label: ["team:platforms", "release:r42"],
      environment: "prod",
    });
  });

  it("round-trips saved scopes through storage, dropping corrupt entries", () => {
    window.localStorage.setItem(
      "runs-saved-scopes",
      JSON.stringify([
        { id: "a", name: "Platform nightly", params: "label=team:platforms" },
        { broken: true },
      ]),
    );
    const loaded = loadSavedScopes();
    expect(loaded).toEqual([
      { id: "a", name: "Platform nightly", params: "label=team:platforms" },
    ]);
    saveSavedScopes([
      { id: "b", name: "Cheap", params: "cost_max=0.1" },
    ]);
    expect(loadSavedScopes()).toEqual([{ id: "b", name: "Cheap", params: "cost_max=0.1" }]);
  });
});
