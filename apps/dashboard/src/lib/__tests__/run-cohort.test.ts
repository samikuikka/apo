import { describe, expect, it } from "vitest";

import {
  hrefWithRunCohort,
  parseDrilldownCohort,
  parseRunCohort,
  withViewId,
} from "../run-cohort";

describe("parseRunCohort", () => {
  it("parses single model/effort/since values", () => {
    expect(
      parseRunCohort({ model: "claude-opus-4.5", effort: "high", since: "7d", provider: "fireworks" }),
    ).toEqual({ model: "claude-opus-4.5", effort: "high", since: "7d", provider: "fireworks" });
  });

  it("empty and missing values mean all-history (null cohort)", () => {
    expect(parseRunCohort({})).toEqual({ model: null, effort: null, since: null, provider: null });
    expect(parseRunCohort({ model: "", since: undefined })).toEqual({
      model: null,
      effort: null,
      since: null,
      provider: null,
    });
  });

  it("takes the first value when a param repeats", () => {
    expect(parseRunCohort({ model: ["a", "b"] })).toEqual({
      model: "a",
      effort: null,
      since: null,
      provider: null,
    });
  });
});

describe("parseDrilldownCohort (Runs page hop)", () => {
  it("forwards a single unambiguous model selection", () => {
    expect(parseDrilldownCohort({ model: "claude-opus-5", since: "7d" })).toEqual({
      model: "claude-opus-5",
      effort: null,
      since: "7d",
      provider: null,
    });
  });

  it("drops an ambiguous multi-model selection instead of mangling it", () => {
    // The Runs page packs multi-select as "a,b"; the drill-down vocabulary is
    // single-valued, so forwarding "a,b" would filter for a model named "a,b".
    expect(parseDrilldownCohort({ model: "a,b", since: "7d" })).toEqual({
      model: null,
      effort: null,
      since: "7d",
      provider: null,
    });
    expect(parseDrilldownCohort({ effort: "high,low" })).toEqual({
      model: null,
      effort: null,
      since: null,
      provider: null,
    });
  });
});

describe("withViewId", () => {
  it("appends the view param to a plain href", () => {
    expect(withViewId("/project/p/tasks", "v1")).toBe("/project/p/tasks?view=v1");
  });

  it("appends after existing query params", () => {
    expect(withViewId("/project/p/tasks?model=opus", "v1")).toBe(
      "/project/p/tasks?model=opus&view=v1",
    );
  });

  it("leaves the href untouched without a view id", () => {
    expect(withViewId("/project/p/tasks?model=opus", null)).toBe(
      "/project/p/tasks?model=opus",
    );
  });
});

describe("hrefWithRunCohort (regression)", () => {
  it("still appends cohort params and leaves empty cohorts plain", () => {
    expect(hrefWithRunCohort("/x", { model: "opus", effort: null, since: "7d", provider: null })).toBe(
      "/x?model=opus&since=7d",
    );
    expect(
      hrefWithRunCohort("/x", { model: null, effort: null, since: null, provider: null }),
    ).toBe("/x");
  });
});
