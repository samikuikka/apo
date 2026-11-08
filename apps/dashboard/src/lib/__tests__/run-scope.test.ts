import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_RUN_SCOPE,
  filterRunScopeDimensions,
  parseRunScope,
  runScopeChips,
  runScopeDimensions,
  runScopeFacets,
  runScopeQuery,
  toggleRunScopeValue,
  writeRunScope,
} from "../run-scope";

describe("run scope", () => {
  it("reads the API's own encoding from either kind of search params", () => {
    const fromUrl = parseRunScope(
      new URLSearchParams("environment=prod,staging&label=customer:c-1&label=customer:c-2&label=agent:a-1"),
    );
    const fromPage = parseRunScope({
      environment: "prod,staging",
      label: ["customer:c-1", "customer:c-2", "agent:a-1"],
    });
    expect(fromUrl).toEqual(fromPage);
    expect(fromUrl).toEqual({
      environments: ["prod", "staging"],
      labels: { customer: ["c-1", "c-2"], agent: ["a-1"] },
    });
  });

  it("splits a label on its first colon, so ids may contain colons", () => {
    expect(parseRunScope({ label: "repo:github:acme/app" }).labels).toEqual({ repo: ["github:acme/app"] });
  });

  it("drops malformed labels rather than sending a filter the API refuses", () => {
    expect(parseRunScope({ label: ["customer", ":c-1", "customer:"] }).labels).toEqual({});
  });

  it("round-trips through the URL and forwards unchanged to the list APIs", () => {
    const scope = { environments: ["prod"], labels: { customer: ["c-1"], agent: ["a:1"] } };
    const params = new URLSearchParams("q=x&label=old:1");
    writeRunScope(params, scope);
    expect(params.get("q")).toBe("x");
    expect(parseRunScope(params)).toEqual(scope);
    expect(runScopeQuery(scope)).toEqual({
      environment: ["prod"],
      label: ["customer:c-1", "agent:a:1"],
    });
    expect(runScopeQuery({ environments: [], labels: {} })).toEqual({});
  });

  it("names options by label name, disambiguating a name two ids share by id", () => {
    const [picker] = runScopeFacets(
      {
        environments: [],
        labels: [
          {
            key: "customer",
            values: [
              { id: "c-1", name: "Acme", count: 1 },
              { id: "c-2", name: "Acme", count: 1 },
              { id: "c-3", name: "Globex", count: 1 },
            ],
          },
        ],
      },
      { environments: [], labels: {} },
      () => {},
    );
    expect(picker.options).toEqual([
      { value: "c-1", label: "Acme (c-1)" },
      { value: "c-2", label: "Acme (c-2)" },
      { value: "c-3", label: "Globex" },
    ]);
  });

  it("replaces a key's ids with the picked one and leaves other keys alone", () => {
    const onChange = vi.fn();
    const [, customer] = runScopeFacets(
      {
        environments: [],
        labels: [
          { key: "agent", values: [{ id: "a-1", name: "Support", count: 1 }] },
          { key: "customer", values: [{ id: "c-1", name: "Acme", count: 1 }] },
        ],
      },
      { environments: [], labels: { agent: ["a-1"], customer: ["c-1", "c-2"] } },
      onChange,
    );
    customer.onChange("c-1");
    expect(onChange).toHaveBeenLastCalledWith({ environments: [], labels: { agent: ["a-1"], customer: ["c-1"] } });
    customer.onChange(null);
    expect(onChange).toHaveBeenLastCalledWith({ environments: [], labels: { agent: ["a-1"] } });
  });
});

describe("scope dimensions", () => {
  const facets = {
    environments: [
      { value: "prod", count: 4 },
      { value: "staging", count: 1 },
    ],
    labels: [
      {
        key: "customer",
        values: [
          { id: "c-1", name: "Acme", count: 3 },
          { id: "c-2", name: "Globex", count: 2 },
        ],
      },
    ],
  } satisfies Parameters<typeof runScopeDimensions>[0];

  it("discovers Environment first, then label keys", () => {
    const dims = runScopeDimensions(facets, EMPTY_RUN_SCOPE);
    expect(dims.map((d) => d.key)).toEqual(["@environment", "customer"]);
  });

  it("omits the environment dimension until a second value or a selection exists", () => {
    const single = { ...facets, environments: [{ value: "prod", count: 5 }] };
    expect(runScopeDimensions(single, EMPTY_RUN_SCOPE).map((d) => d.key)).toEqual(["customer"]);
    const selected = { environments: ["prod"], labels: {} };
    expect(runScopeDimensions(single, selected).map((d) => d.key)).toEqual(["@environment", "customer"]);
  });

  it("keeps a URL-selected value listed even when the facets do not know it", () => {
    const scope = { environments: [], labels: { customer: ["c-9"], ghost: ["g-1"] } };
    const dims = runScopeDimensions(facets, scope);
    const customer = dims.find((d) => d.key === "customer");
    expect(customer?.values.map((v) => v.id)).toContain("c-9");
    expect(dims.map((d) => d.key)).toContain("ghost");
  });

  it("toggles values within environment and label dimensions", () => {
    const base = { environments: ["prod"], labels: { customer: ["c-1"] } };
    expect(toggleRunScopeValue(base, "@environment", "staging")).toEqual({
      environments: ["prod", "staging"],
      labels: { customer: ["c-1"] },
    });
    expect(toggleRunScopeValue(base, "customer", "c-1")).toEqual({
      environments: ["prod"],
      labels: {},
    });
  });

  it("resolves chips to the newest name, falling back to the raw id", () => {
    const scope = { environments: ["prod"], labels: { customer: ["c-1", "c-9"] } };
    const chips = runScopeChips(scope, runScopeDimensions(facets, scope));
    expect(chips).toEqual([
      { key: "@environment", label: "Environment", id: "prod", name: "prod" },
      { key: "customer", label: "customer", id: "c-1", name: "Acme" },
      { key: "customer", label: "customer", id: "c-9", name: "c-9" },
    ]);
  });

  it("narrows search to matching keys whole and matching values only", () => {
    const dims = runScopeDimensions(facets, EMPTY_RUN_SCOPE);
    expect(filterRunScopeDimensions(dims, "cust").map((d) => d.key)).toEqual(["customer"]);
    const byValue = filterRunScopeDimensions(dims, "acme");
    expect(byValue.map((d) => d.key)).toEqual(["customer"]);
    expect(byValue[0]?.values.map((v) => v.id)).toEqual(["c-1"]);
    expect(filterRunScopeDimensions(dims, "nope")).toEqual([]);
  });
});
