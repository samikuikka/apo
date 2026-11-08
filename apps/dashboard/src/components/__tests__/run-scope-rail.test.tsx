/**
 * The Runs filter rail: dimension sections discovered from the facets,
 * live-apply checkboxes, carried URL values, and the remembered open/closed
 * state that RailToggle reads.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RailToggle, ScopeRail, useRailVisible } from "@/components/run-scope-rail";
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
