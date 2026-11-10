/**
 * An active filter must be visible and individually removable: an invisible
 * label or provider filter reads as a mysteriously short trace list.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TraceActiveFilters } from "@/components/trace-active-filters";
import { hasActiveFilters, type TraceFilters } from "@/hooks/use-filters";

function filtersWith(
  labels: Record<string, string[]>,
  extra: Partial<TraceFilters> = {},
): TraceFilters {
  return {
    timePreset: "all",
    tags: [],
    models: [],
    providers: [],
    span_predicates: [],
    labels,
    ...extra,
  } as TraceFilters;
}

describe("TraceActiveFilters labels", () => {
  it("renders one chip per selected label id", () => {
    render(
      <TraceActiveFilters
        filters={filtersWith({ customer: ["acme", "globex"], team: ["platforms"] })}
        onRemoveFilter={vi.fn()}
        onClearAll={vi.fn()}
      />
    );
    expect(screen.getByText("customer:acme")).toBeTruthy();
    expect(screen.getByText("customer:globex")).toBeTruthy();
    expect(screen.getByText("team:platforms")).toBeTruthy();
  });

  it("removing one label keeps the other ids and keys", async () => {
    const onRemoveFilter = vi.fn();
    render(
      <TraceActiveFilters
        filters={filtersWith({ customer: ["acme", "globex"], team: ["platforms"] })}
        onRemoveFilter={onRemoveFilter}
        onClearAll={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove customer:acme filter" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("labels", {
      customer: ["globex"],
      team: ["platforms"],
    });
  });

  it("removing the last id of a key drops the key entirely", async () => {
    const onRemoveFilter = vi.fn();
    render(
      <TraceActiveFilters
        filters={filtersWith({ customer: ["acme"], team: ["platforms"] })}
        onRemoveFilter={onRemoveFilter}
        onClearAll={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove customer:acme filter" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("labels", { team: ["platforms"] });
  });

  it("removing one provider passes the remaining providers, not a full clear", async () => {
    const onRemoveFilter = vi.fn();
    render(
      <TraceActiveFilters
        filters={filtersWith({}, { providers: ["openrouter", "baseten"] })}
        onRemoveFilter={onRemoveFilter}
        onClearAll={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove openrouter filter" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("providers", ["baseten"]);
  });

  it("renders nothing when only empty label arrays are set", () => {
    const { container } = render(
      <TraceActiveFilters
        filters={filtersWith({ customer: [] })}
        onRemoveFilter={vi.fn()}
        onClearAll={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("hasActiveFilters labels", () => {
  it("counts a labels-only filter as active", () => {
    expect(hasActiveFilters(filtersWith({ customer: ["acme"] }))).toBe(true);
  });

  it("treats empty label arrays as no filter", () => {
    expect(hasActiveFilters(filtersWith({ customer: [] }))).toBe(false);
    expect(hasActiveFilters(filtersWith({}))).toBe(false);
  });
});
