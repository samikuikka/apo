/**
 * The task detail page's run-history scope controls.
 *
 * TaskRunHistoryControls is the presentational surface (pickers + status
 * chips + view chip + escape); RunHistoryScopeBar owns the URL: scope changes
 * replace the search params (never push) and the view chip resolves ?view=
 * against the saved views, hiding itself once the scope diverges.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  RunHistoryScopeBar,
  TaskRunHistoryControls,
} from "../run-history-scope-bar";
import type { RunConfigModelFacet } from "@/lib/agent-task-view-api";

const FACETS: RunConfigModelFacet[] = [
  {
    model: "claude-opus-5",
    count: 4,
    efforts: [
      { effort: "high", count: 2 },
      { effort: "low", count: 2 },
    ],
    archived: false,
  },
  { model: "deepseek-v4", count: 3, efforts: [], archived: false },
];

let replaceMock: ReturnType<typeof vi.fn>;
let searchParamsHolder: URLSearchParams;
let savedViewsMock: (...args: unknown[]) => Promise<unknown[]>;

vi.mock("next/navigation", () => ({
  usePathname: () => "/project/acme/tasks/t1",
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => searchParamsHolder,
}));

vi.mock("@/lib/agent-task-view-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/agent-task-view-api")
  >("@/lib/agent-task-view-api");
  return {
    ...actual,
    fetchSavedViews: (...args: unknown[]) => savedViewsMock(...args),
  };
});

beforeEach(() => {
  // The router mock closes the loop a real navigation would: every replace
  // feeds the written URL back into the params the component reads, so scope
  // accumulates across clicks the way it does in the browser.
  replaceMock = vi.fn((url: string) => {
    const qs = url.split("?")[1] ?? "";
    searchParamsHolder = new URLSearchParams(qs);
  });
  savedViewsMock = vi.fn().mockResolvedValue([]);
  searchParamsHolder = new URLSearchParams();
});

describe("TaskRunHistoryControls (presentational)", () => {
  it("renders the model label and an escape link", () => {
    render(
      <TaskRunHistoryControls
        scope={{ model: "claude-opus-5", effort: null, since: null,
    provider: null, status: new Set() }}
        facets={FACETS}
        viewLabel={null}
        onScopeChange={() => {}}
        onReset={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Model filter" })).toHaveTextContent(
      "claude-opus-5",
    );
    expect(screen.getByText("All history")).toBeInTheDocument();
  });

  it("shows the effort picker only when the selected model has 2+ effort tiers", () => {
    const view = (model: string | null) =>
      render(
        <TaskRunHistoryControls
          scope={{ model, effort: null, since: null,
    provider: null, status: new Set() }}
          facets={FACETS}
          viewLabel={null}
          onScopeChange={() => {}}
          onReset={() => {}}
        />,
      );
    const withTiers = view("claude-opus-5");
    expect(withTiers.getByRole("combobox", { name: "Effort filter" })).toBeInTheDocument();
    withTiers.unmount();

    const withoutTiers = view("deepseek-v4");
    expect(
      withoutTiers.queryByRole("combobox", { name: "Effort filter" }),
    ).not.toBeInTheDocument();
    withoutTiers.unmount();

    const noModel = view(null);
    expect(
      noModel.queryByRole("combobox", { name: "Effort filter" }),
    ).not.toBeInTheDocument();
  });

  it("reflects the status selection in the menu and reports toggles as the next set", async () => {
    const onScopeChange = vi.fn();
    render(
      <TaskRunHistoryControls
        scope={{ model: null, effort: null, since: null,
    provider: null, status: new Set(["failed"]) }}
        facets={FACETS}
        viewLabel={null}
        onScopeChange={onScopeChange}
        onReset={() => {}}
      />,
    );
    // The closed trigger summarizes the selection instead of showing chips.
    expect(screen.getByRole("button", { name: "Status filter" })).toHaveTextContent("Failed");

    await userEvent.click(screen.getByRole("button", { name: "Status filter" }));
    expect(screen.getByRole("menuitemcheckbox", { name: /failed/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemcheckbox", { name: /passed/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /passed/i }));
    expect(onScopeChange).toHaveBeenCalledWith({
      status: new Set(["failed", "passed"]),
    });
  });

  it("renders the view chip only when a view label is provided", () => {
    const view = (viewLabel: string | null) =>
      render(
        <TaskRunHistoryControls
          scope={{ model: null, effort: null, since: null,
    provider: null, status: new Set() }}
          facets={FACETS}
          viewLabel={viewLabel}
          onScopeChange={() => {}}
          onReset={() => {}}
        />,
      );
    const withLabel = view("My Opus view");
    expect(withLabel.getByText("scoped to view: My Opus view")).toBeInTheDocument();
    withLabel.unmount();
    expect(view(null).queryByText(/scoped to view:/)).not.toBeInTheDocument();
  });

  it("calls onReset from the All history escape", async () => {
    const onReset = vi.fn();
    render(
      <TaskRunHistoryControls
        scope={{ model: "claude-opus-5", effort: null, since: "7d",
    provider: null, status: new Set() }}
        facets={FACETS}
        viewLabel={null}
        onScopeChange={() => {}}
        onReset={onReset}
      />,
    );
    await userEvent.click(screen.getByText("All history"));
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe("RunHistoryScopeBar (URL ownership)", () => {
  it("replaces the URL with scope params, comma-joined for status, omitting empties", async () => {
    searchParamsHolder = new URLSearchParams("model=claude-opus-5");
    const { rerender } = render(<RunHistoryScopeBar projectId="acme" facets={FACETS} />);

    // Status writes are debounced (a burst of picks lands as one URL write),
    // so each pick is awaited via the replace it eventually triggers.
    await userEvent.click(screen.getByRole("button", { name: "Status filter" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /passed/i }));
    await waitFor(
      () => expect(replaceMock).toHaveBeenCalledTimes(1),
      { timeout: 1500 },
    );
    await userEvent.keyboard("{Escape}");
    rerender(<RunHistoryScopeBar projectId="acme" facets={FACETS} />);
    await userEvent.click(screen.getByRole("button", { name: "Status filter" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /errored/i }));
    await waitFor(
      () => expect(replaceMock).toHaveBeenCalledTimes(2),
      { timeout: 1500 },
    );
    rerender(<RunHistoryScopeBar projectId="acme" facets={FACETS} />);

    const first = replaceMock.mock.calls[0]?.[0] as string;
    const second = replaceMock.mock.calls[1]?.[0] as string;
    expect(first).toContain("model=claude-opus-5");
    expect(first).toContain("status=passed");
    // URLSearchParams encodes the comma join as %2C (same encoding the Runs
    // page has always used for multi-model); the backend decodes it back.
    expect(second).toContain("status=passed%2Cerror");
    expect(second).not.toContain("effort=");
    expect(second).not.toContain("since=");
  });

  it("reset strips only the scope params and keeps the view identity", async () => {
    searchParamsHolder = new URLSearchParams("model=claude-opus-5&since=7d&view=v1");
    render(<RunHistoryScopeBar projectId="acme" facets={FACETS} />);

    await userEvent.click(screen.getByText("All history"));

    expect(replaceMock).toHaveBeenCalledWith(expect.stringMatching(/view=v1/));
    const url = replaceMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain("model=");
    expect(url).not.toContain("since=");
    expect(url).not.toContain("status=");
  });

  it("resolves the view label from saved views and hides it when the scope diverged", async () => {
    savedViewsMock = vi.fn().mockResolvedValue([
      { id: "v1", label: "My Opus view", model: "claude-opus-5", effort: null, since: "7d" },
    ]);

    const { rerender } = render(
      <RunHistoryScopeBar projectId="acme" facets={FACETS} />,
    );
    searchParamsHolder = new URLSearchParams("model=claude-opus-5&since=7d&view=v1");
    rerender(<RunHistoryScopeBar projectId="acme" facets={FACETS} />);

    await waitFor(() => {
      expect(screen.getByText("scoped to view: My Opus view")).toBeInTheDocument();
    });

    // Diverge: the model no longer matches the view's — the chip disappears.
    searchParamsHolder = new URLSearchParams("model=deepseek-v4&since=7d&view=v1");
    rerender(<RunHistoryScopeBar projectId="acme" facets={FACETS} />);
    await waitFor(() => {
      expect(screen.queryByText(/scoped to view:/)).not.toBeInTheDocument();
    });
  });

  it("never renders a chip for an unknown view id", async () => {
    savedViewsMock = vi.fn().mockResolvedValue([]);
    searchParamsHolder = new URLSearchParams("view=ghost");
    render(<RunHistoryScopeBar projectId="acme" facets={FACETS} />);
    await waitFor(() => expect(savedViewsMock).toHaveBeenCalled());
    expect(screen.queryByText(/scoped to view:/)).not.toBeInTheDocument();
  });
});

describe("TaskRunHistoryControls serving hosts (issue #307)", () => {
  it("renders the selected host on the Hosts trigger", () => {
    render(
      <TaskRunHistoryControls
        scope={{
          model: null,
          effort: null,
          since: null,
          provider: "openrouter:nitro",
          status: new Set(),
        }}
        facets={FACETS}
        hostOptions={[{ label: "openrouter:nitro", count: 1 }, { label: "fireworks", count: 1 }]}
        viewLabel={null}
        onScopeChange={() => {}}
        onReset={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Hosts filter" })).toHaveTextContent(
      "openrouter:nitro",
    );
  });

  it("hides the Hosts control when the task's runs reported no hosts", () => {
    render(
      <TaskRunHistoryControls
        scope={{ model: null, effort: null, since: null, provider: null, status: new Set() }}
        facets={FACETS}
        hostOptions={[]}
        viewLabel={null}
        onScopeChange={() => {}}
        onReset={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Hosts filter" })).toBeNull();
  });
});
