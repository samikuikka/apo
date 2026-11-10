import { describe, expect, it } from "vitest";

import {
  applyTokensToFilters,
  parseSearchTokens,
  suggestTokens,
} from "../search-tokens";
import { EMPTY_METRIC_FILTERS } from "../run-metric-filters";
import { EMPTY_RUN_SCOPE } from "../run-scope";
import type { RunLabelFacets } from "@/lib/agent-task-api";

const facets: RunLabelFacets = {
  environments: [
    { value: "prod", count: 4 },
    { value: "staging", count: 1 },
  ],
  labels: [
    {
      key: "customer",
      values: [
        { id: "acme", name: "Acme", count: 3 },
        { id: "globex", name: "Globex", count: 2 },
      ],
    },
    { key: "team", values: [{ id: "platforms", name: "platforms", count: 5 }] },
  ],
};

describe("parseSearchTokens", () => {
  it("extracts a label token when the key is a known dimension", () => {
    const parsed = parseSearchTokens("customer:acme", facets);
    expect(parsed.tokens).toEqual([{ kind: "label", key: "customer", id: "acme" }]);
    expect(parsed.text).toBe("");
  });

  it("leaves unknown key:value pairs as free text", () => {
    const parsed = parseSearchTokens("unknown:value", facets);
    expect(parsed.tokens).toEqual([]);
    expect(parsed.text).toBe("unknown:value");
  });

  it("mixes tokens and free text", () => {
    const parsed = parseSearchTokens("customer:acme timeout team:platforms", facets);
    expect(parsed.tokens).toEqual([
      { kind: "label", key: "customer", id: "acme" },
      { kind: "label", key: "team", id: "platforms" },
    ]);
    expect(parsed.text).toBe("timeout");
  });

  it("parses cost and duration ranges in both directions", () => {
    const parsed = parseSearchTokens("cost>0.50 cost<2 duration>60 duration<=300", facets);
    expect(parsed.tokens).toEqual([
      { kind: "cost", bound: "min", value: 0.5 },
      { kind: "cost", bound: "max", value: 2 },
      { kind: "duration", bound: "min", value: 60 },
      { kind: "duration", bound: "max", value: 300 },
    ]);
  });

  it("parses env: and environment: tokens", () => {
    const parsed = parseSearchTokens("env:prod environment:staging", facets);
    expect(parsed.tokens).toEqual([
      { kind: "environment", value: "prod" },
      { kind: "environment", value: "staging" },
    ]);
  });

  it("rejects negative or non-numeric range values", () => {
    const parsed = parseSearchTokens("cost>-1 duration>abc", facets);
    expect(parsed.tokens).toEqual([]);
    expect(parsed.text).toBe("cost>-1 duration>abc");
  });

  it("works without facets (ranges and env still parse)", () => {
    const parsed = parseSearchTokens("cost>0.10 env:prod", null);
    expect(parsed.tokens).toEqual([
      { kind: "cost", bound: "min", value: 0.1 },
      { kind: "environment", value: "prod" },
    ]);
  });
});

describe("applyTokensToFilters", () => {
  it("adds a label to an empty scope", () => {
    const { scope, changed } = applyTokensToFilters(
      [{ kind: "label", key: "customer", id: "acme" }],
      EMPTY_RUN_SCOPE,
      EMPTY_METRIC_FILTERS,
    );
    expect(scope.labels).toEqual({ customer: ["acme"] });
    expect(changed).toBe(true);
  });

  it("ORs a second label into the same key", () => {
    const { scope } = applyTokensToFilters(
      [{ kind: "label", key: "customer", id: "globex" }],
      { environments: [], labels: { customer: ["acme"] } },
      EMPTY_METRIC_FILTERS,
    );
    expect(scope.labels.customer).toEqual(["acme", "globex"]);
  });

  it("sets cost and duration bounds", () => {
    const { metrics } = applyTokensToFilters(
      [
        { kind: "cost", bound: "min", value: 0.1 },
        { kind: "duration", bound: "max", value: 300 },
      ],
      EMPTY_RUN_SCOPE,
      EMPTY_METRIC_FILTERS,
    );
    expect(metrics.cost.min).toBe(0.1);
    expect(metrics.durationSeconds.max).toBe(300);
  });

  it("does not duplicate an already-selected label", () => {
    const { changed } = applyTokensToFilters(
      [{ kind: "label", key: "customer", id: "acme" }],
      { environments: [], labels: { customer: ["acme"] } },
      EMPTY_METRIC_FILTERS,
    );
    expect(changed).toBe(false);
  });
});

describe("suggestTokens", () => {
  it("suggests values for a known key prefix", () => {
    const suggestions = suggestTokens("customer:ac", facets);
    expect(suggestions).toEqual([
      { insert: "customer:acme", label: "customer:Acme", count: 3 },
    ]);
  });

  it("suggests environments for env: prefix", () => {
    const suggestions = suggestTokens("env:pro", facets);
    expect(suggestions).toEqual([
      { insert: "env:prod", label: "environment: prod", count: 4 },
    ]);
  });

  it("suggests dimension keys for a bare prefix", () => {
    const suggestions = suggestTokens("cus", facets);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.insert).toContain("customer:");
  });

  it("returns nothing for free text with no filter prefix", () => {
    expect(suggestTokens("timeout", facets)).toEqual([]);
  });
});
