/**
 * The Traces sidebar's Run labels group: each caller-defined dimension is a
 * native section under one collapsible group, and checking a value reports
 * the label selection the traces list filters by.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TraceFilterControls } from "@/components/trace-filter-controls";
import type { FilterActions, TraceFilters } from "@/hooks/use-filters";

function filters(overrides: Partial<TraceFilters> = {}): TraceFilters {
  return {
    timePreset: "all",
    tags: [],
    models: [],
    providers: [],
    span_predicates: [],
    labels: {},
    ...overrides,
  };
}

function actions(): FilterActions {
  return {
    setTimePreset: vi.fn(),
    setCustomTimeRange: vi.fn(),
    setProject: vi.fn(),
    setTaskId: vi.fn(),
    setEnvironment: vi.fn(),
    setLabels: vi.fn(),
    setSessionId: vi.fn(),
    setTags: vi.fn(),
    setModels: vi.fn(),
    setProviders: vi.fn(),
    setMetricFilter: vi.fn(),
    setSearch: vi.fn(),
    setSpanSearch: vi.fn(),
    setSpanPredicates: vi.fn(),
    setDurationRange: vi.fn(),
    clearAllFilters: vi.fn(),
    removeFilter: vi.fn(),
  };
}

const labelFacets = {
  environments: [],
  labels: [
    {
      key: "customer",
      values: [
        { id: "acme", name: "Acme", count: 3 },
        { id: "globex", name: "Globex", count: 2 },
      ],
    },
    { key: "team", values: [{ id: "platforms", name: "platforms", count: 3 }] },
  ],
};

describe("Traces sidebar run labels", () => {
  it("groups every dimension under a Run labels header, expanded", () => {
    render(
      <TraceFilterControls
        filters={filters()}
        actions={actions()}
        labelFacets={labelFacets}
      />,
    );
    expect(screen.getByRole("button", { name: /Run labels/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "customer Acme" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "team platforms" })).toBeInTheDocument();
  });

  it("checking a value reports the label selection", async () => {
    const act = actions();
    render(<TraceFilterControls filters={filters()} actions={act} labelFacets={labelFacets} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "customer Acme" }));
    expect(act.setLabels).toHaveBeenCalledWith({ customer: ["acme"] });
  });

  it("a second value of the same key ORs into the selection", async () => {
    const act = actions();
    render(
      <TraceFilterControls
        filters={filters({ labels: { customer: ["acme"] } })}
        actions={act}
        labelFacets={labelFacets}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "customer Globex" }));
    expect(act.setLabels).toHaveBeenCalledWith({ customer: ["acme", "globex"] });
  });

  it("hides every dimension when the group header is clicked, keeping the count", async () => {
    render(
      <TraceFilterControls
        filters={filters({ labels: { customer: ["acme"] } })}
        actions={actions()}
        labelFacets={labelFacets}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Run labels \(1\)/ }));
    expect(screen.queryByRole("checkbox", { name: "customer Acme" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "team platforms" })).toBeNull();
  });

  it("renders nothing without facets", () => {
    const { container } = render(
      <TraceFilterControls filters={filters()} actions={actions()} labelFacets={null} />,
    );
    expect(screen.queryByRole("button", { name: /Run labels/ })).toBeNull();
    expect(container).toBeInTheDocument();
  });
});
