/**
 * The Runs filter rail: dimension sections discovered from the facets,
 * live-apply checkboxes, carried URL values, and the remembered open/closed
 * state that RailToggle reads.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RailToggle, ScopeRail, useRailVisible } from "@/components/run-scope-rail";
import { EMPTY_METRIC_FILTERS, type RunMetricFilters } from "@/lib/run-metric-filters";
import type { RunLabelFacets } from "@/lib/agent-task-api";
import { EMPTY_RUN_SCOPE, parseRunScope, type RunScope } from "@/lib/run-scope";

// Node 25 ships a global localStorage without the Storage methods; the DOM
// one comes from the stub, same pattern as the persistence scene tests.
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

const facets: RunLabelFacets = {
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
    { key: "team", values: [{ id: "platforms", name: "platforms", count: 5 }] },
  ],
};

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

describe("ScopeRail", () => {
  it("renders one section per dimension with its values and counts", () => {
    render(
      <ScopeRail facets={facets} scope={EMPTY_RUN_SCOPE} onScopeChange={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("checkbox", { name: "Environment prod" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "customer Acme" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "team platforms" })).toBeInTheDocument();
  });

  it("applies immediately: a value click reports the toggled scope", () => {
    const onScopeChange = vi.fn();
    render(
      <ScopeRail facets={facets} scope={EMPTY_RUN_SCOPE} onScopeChange={onScopeChange} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "customer Acme" }));
    expect(onScopeChange).toHaveBeenCalledWith({
      environments: [],
      labels: { customer: ["c-1"] },
    });
  });

  it("unchecks an already-selected value", () => {
    const onScopeChange = vi.fn();
    const scope = parseRunScope(new URLSearchParams("label=customer:c-1"));
    render(
      <ScopeRail facets={facets} scope={scope} onScopeChange={onScopeChange} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "customer Acme" }));
    expect(onScopeChange).toHaveBeenCalledWith(EMPTY_RUN_SCOPE);
  });

  it("search narrows to matching dimensions and values", () => {
    render(
      <ScopeRail facets={facets} scope={EMPTY_RUN_SCOPE} onScopeChange={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Search dimensions and values"), {
      target: { value: "acme" },
    });
    expect(screen.getByRole("checkbox", { name: "customer Acme" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "customer Globex" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "team platforms" })).toBeNull();
  });

  it("chips remove one value and Clear All empties the scope", () => {
    const onScopeChange = vi.fn();
    const scope = parseRunScope(new URLSearchParams("environment=prod&label=customer:c-1"));
    render(
      <ScopeRail facets={facets} scope={scope} onScopeChange={onScopeChange} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove customer Acme" }));
    expect(onScopeChange).toHaveBeenLastCalledWith({
      environments: ["prod"],
      labels: {},
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    expect(onScopeChange).toHaveBeenLastCalledWith(EMPTY_RUN_SCOPE);
  });

  it("closing from the header reports onClose", () => {
    const onClose = vi.fn();
    render(
      <ScopeRail facets={facets} scope={EMPTY_RUN_SCOPE} onScopeChange={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide filters" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("RailToggle", () => {
  const scope: RunScope = { environments: [], labels: { customer: ["c-1"] } };

  it("while closed: shows the active count, the chips, and a Clear link", () => {
    render(
      <RailToggle facets={facets} scope={scope} onScopeChange={vi.fn()} open={false} onToggle={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Show filters" })).toHaveTextContent("1 active");
    expect(screen.getByRole("button", { name: "Remove customer Acme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("while open: chips live in the rail, so the toggle carries none", () => {
    render(
      <RailToggle facets={facets} scope={scope} onScopeChange={vi.fn()} open onToggle={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Hide filters" })).toHaveTextContent("1 active");
    expect(screen.queryByRole("button", { name: "Remove customer Acme" })).toBeNull();
  });

  it("with no selection: the button counts dimensions instead of actives", () => {
    render(
      <RailToggle facets={facets} scope={EMPTY_RUN_SCOPE} onScopeChange={vi.fn()} open={false} onToggle={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Show filters" })).toHaveTextContent("3 dimensions");
  });
});

describe("useRailVisible", () => {
  function Harness() {
    const [open, setOpen] = useRailVisible();
    return (
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? "visible" : "hidden"}
      </button>
    );
  }

  it("defaults to visible and remembers closing across mounts", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByRole("button", { name: "visible" })).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "visible" }));
    });
    expect(screen.getByRole("button", { name: "hidden" })).toBeInTheDocument();
    expect(localStorage.getItem("runs-filters-visible")).toBe("false");

    unmount();
    render(<Harness />);
    expect(screen.getByRole("button", { name: "hidden" })).toBeInTheDocument();
  });
});

describe("metric sections", () => {
  const metrics: RunMetricFilters = {
    cost: { min: null, max: null },
    durationSeconds: { min: null, max: null },
  };
  // A project whose own distribution sets the preset cutoffs.
  const facetsWithMetrics: RunLabelFacets = {
    ...facets,
    metrics: {
      cost: { p20: 0.08, p50: 0.23, p80: 0.61 },
      duration_seconds: { p20: 30, p50: 90, p80: 300 },
    },
  };

  function renderRail(
    railFacets: RunLabelFacets | null = facetsWithMetrics,
    overrides: Partial<RunMetricFilters> = {},
    onScopeChange: (next: RunScope) => void = vi.fn(),
  ) {
    const onMetricsChange = vi.fn();
    render(
      <ScopeRail
        facets={railFacets}
        scope={EMPTY_RUN_SCOPE}
        onScopeChange={onScopeChange}
        metrics={{ ...metrics, ...overrides }}
        onMetricsChange={onMetricsChange}
        onClose={vi.fn()}
      />,
    );
    return onMetricsChange;
  }

  it("renders Cost and Duration sections with the median and derived presets", () => {
    renderRail();
    expect(screen.getByText("median $0.23")).toBeInTheDocument();
    expect(screen.getByText("median 1.5 min")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cheapest 20% under \$0\.08/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Slowest 20% over 5 min/ })).toBeInTheDocument();
  });

  it("a cost preset applies the project's own cutoffs", () => {
    const onMetricsChange = renderRail();
    fireEvent.click(screen.getByRole("button", { name: /Cheapest 20%/ }));
    expect(onMetricsChange).toHaveBeenCalledWith({
      cost: { min: null, max: 0.08 },
      durationSeconds: { min: null, max: null },
    });
  });

  it("a duration preset applies second cutoffs from the distribution", () => {
    const onMetricsChange = renderRail();
    fireEvent.click(screen.getByRole("button", { name: /Fastest 20%/ }));
    expect(onMetricsChange).toHaveBeenCalledWith({
      cost: { min: null, max: null },
      durationSeconds: { min: null, max: 30 },
    });
  });

  it("shows no presets when the project has no distribution, but keeps the inputs", () => {
    renderRail(facets);
    expect(screen.queryByRole("button", { name: /Cheapest 20%/ })).toBeNull();
    expect(screen.getByLabelText("Cost minimum")).toBeInTheDocument();
  });

  it("clicking the pressed preset clears the range", () => {
    const onMetricsChange = renderRail(
      facetsWithMetrics,
      { durationSeconds: { min: 300, max: null } },
    );
    const preset = screen.getByRole("button", { name: /Slowest 20%/ });
    expect(preset.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(preset);
    expect(onMetricsChange).toHaveBeenCalledWith(EMPTY_METRIC_FILTERS);
  });

  it("a typed duration bound commits in seconds on blur", () => {
    const onMetricsChange = renderRail();
    fireEvent.change(screen.getByLabelText("Duration minimum"), { target: { value: "2" } });
    fireEvent.blur(screen.getByLabelText("Duration minimum"));
    expect(onMetricsChange).toHaveBeenCalledWith({
      cost: { min: null, max: null },
      durationSeconds: { min: 120, max: null },
    });
  });

  it("Clear All clears the metrics with the scope", () => {
    const onScopeChange = vi.fn();
    const onMetricsChange = renderRail(facetsWithMetrics, { cost: { min: 0.1, max: null } }, onScopeChange);
    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    expect(onScopeChange).toHaveBeenCalledWith(EMPTY_RUN_SCOPE);
    expect(onMetricsChange).toHaveBeenCalledWith(EMPTY_METRIC_FILTERS);
  });

  it("removing one metric chip keeps the other metric's range", () => {
    const onMetricsChange = renderRail(
      facetsWithMetrics,
      { cost: { min: 0.1, max: 0.5 }, durationSeconds: { min: 120, max: null } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Cost $0.1 to 0.5" }));
    expect(onMetricsChange).toHaveBeenCalledWith({
      cost: { min: null, max: null },
      durationSeconds: { min: 120, max: null },
    });
  });

  it("an inverted typed pair commits in order", () => {
    const onMetricsChange = renderRail(facetsWithMetrics, { cost: { min: 0.5, max: null } });
    fireEvent.change(screen.getByLabelText("Cost maximum"), { target: { value: "0.1" } });
    fireEvent.blur(screen.getByLabelText("Cost maximum"));
    expect(onMetricsChange).toHaveBeenCalledWith({
      cost: { min: 0.1, max: 0.5 },
      durationSeconds: { min: null, max: null },
    });
  });

  it("the closed toggle shows metric chips and counts them as active", () => {
    render(
      <RailToggle
        facets={facets}
        scope={EMPTY_RUN_SCOPE}
        onScopeChange={vi.fn()}
        metrics={{ cost: { min: 0.1, max: 0.5 }, durationSeconds: { min: null, max: null } }}
        onMetricsChange={vi.fn()}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Show filters" })).toHaveTextContent("1 active");
    expect(screen.getByRole("button", { name: "Remove Cost $0.1 to 0.5" })).toBeInTheDocument();
  });

  it("the closed toggle's metric chip removal keeps the other range", () => {
    const onMetricsChange = vi.fn();
    render(
      <RailToggle
        facets={facets}
        scope={EMPTY_RUN_SCOPE}
        onScopeChange={vi.fn()}
        metrics={{ cost: { min: 0.1, max: 0.5 }, durationSeconds: { min: 120, max: null } }}
        onMetricsChange={onMetricsChange}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Cost $0.1 to 0.5" }));
    expect(onMetricsChange).toHaveBeenCalledWith({
      cost: { min: null, max: null },
      durationSeconds: { min: 120, max: null },
    });
  });
});
