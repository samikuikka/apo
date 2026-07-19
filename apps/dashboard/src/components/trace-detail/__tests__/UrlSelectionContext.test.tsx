import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const replaceMock = vi.fn();
const pushMock = vi.fn();
let searchParams: URLSearchParams;
let pathname: string;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
}));

import {
  UrlSelectionProvider,
} from "../contexts/UrlSelectionContext";
import { useSelection } from "../contexts/SelectionContext";

function Consumer() {
  const {
    selectedRunId,
    selectedCallId,
    view,
    detailTab,
    selectCall,
    selectRun,
    clearSelection,
    setView,
    setDetailTab,
  } = useSelection();
  return (
    <div>
      <span data-testid="selectedRunId">{String(selectedRunId)}</span>
      <span data-testid="selectedCallId">{String(selectedCallId)}</span>
      <span data-testid="view">{view}</span>
      <span data-testid="detailTab">{detailTab}</span>
      <button type="button" data-testid="select-call" onClick={() => selectCall("call-123")} />
      <button type="button" data-testid="select-null" onClick={() => selectCall(null)} />
      <button type="button" data-testid="select-run-same" onClick={() => selectRun("run-1")} />
      <button type="button" data-testid="clear" onClick={clearSelection} />
      <button type="button" data-testid="set-view-timeline" onClick={() => setView("timeline")} />
      <button type="button" data-testid="set-tab-tokens" onClick={() => setDetailTab("tokens")} />
    </div>
  );
}

function renderWithProvider(
  ui: React.ReactElement,
  runId = "run-1",
) {
  return render(<UrlSelectionProvider runId={runId}>{ui}</UrlSelectionProvider>);
}

function lastReplaceUrl(): string {
  const last = replaceMock.mock.calls.at(-1);
  return last ? (last[0] as string) : "";
}

describe("UrlSelectionContext - initial state from URL", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/traces/run-1";
  });

  it("defaults to tree view and empty tab when no params", () => {
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("view").textContent).toBe("tree");
    expect(screen.getByTestId("detailTab").textContent).toBe("");
    expect(screen.getByTestId("selectedCallId").textContent).toBe("null");
  });

  it("reads observation param from URL on mount", () => {
    searchParams = new URLSearchParams("observation=call-abc");
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("selectedCallId").textContent).toBe("call-abc");
  });

  it("reads view param from URL on mount", () => {
    searchParams = new URLSearchParams("view=timeline");
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("view").textContent).toBe("timeline");
  });

  it("reads tab param from URL on mount", () => {
    searchParams = new URLSearchParams("tab=tokens");
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("detailTab").textContent).toBe("tokens");
  });

  it("exposes the current runId as selectedRunId", () => {
    renderWithProvider(<Consumer />, "run-xyz");
    expect(screen.getByTestId("selectedRunId").textContent).toBe("run-xyz");
  });
});

describe("UrlSelectionContext - view param validation", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/traces/run-1";
  });

  it("falls back to tree for invalid view param", () => {
    searchParams = new URLSearchParams("view=invalid-mode");
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("view").textContent).toBe("tree");
  });

  it("supports all valid view values", () => {
    for (const v of ["tree", "timeline", "graph"] as const) {
      searchParams = new URLSearchParams(`view=${v}`);
      const { unmount } = renderWithProvider(<Consumer />);
      expect(screen.getByTestId("view").textContent).toBe(v);
      unmount();
    }
  });
});

describe("UrlSelectionContext - selectCall syncs URL", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/traces/run-1";
  });

  it("sets observation param when selecting a call", () => {
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("select-call").click());

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(lastReplaceUrl()).toContain("observation=call-123");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("removes observation param when selecting null", () => {
    searchParams = new URLSearchParams("observation=call-old");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("select-null").click());

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(lastReplaceUrl()).not.toContain("observation=");
  });

  it("clearSelection removes observation param", () => {
    searchParams = new URLSearchParams("observation=call-old");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("clear").click());

    expect(lastReplaceUrl()).not.toContain("observation=");
  });

  it("preserves other params when updating observation", () => {
    searchParams = new URLSearchParams("view=timeline&tab=tokens");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("select-call").click());

    const url = lastReplaceUrl();
    expect(url).toContain("observation=call-123");
    expect(url).toContain("view=timeline");
    expect(url).toContain("tab=tokens");
  });
});

describe("UrlSelectionContext - selectRun behavior", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/traces/run-1";
  });

  it("clears call selection when selecting the current run", () => {
    searchParams = new URLSearchParams("observation=call-old");
    renderWithProvider(<Consumer />, "run-1");
    act(() => screen.getByTestId("select-run-same").click());

    expect(lastReplaceUrl()).not.toContain("observation=");
  });
});

describe("UrlSelectionContext - view sync", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/traces/run-1";
  });

  it("sets view param via setView", () => {
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("set-view-timeline").click());

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(lastReplaceUrl()).toContain("view=timeline");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("preserves observation when updating view", () => {
    searchParams = new URLSearchParams("observation=call-x");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("set-view-timeline").click());

    const url = lastReplaceUrl();
    expect(url).toContain("view=timeline");
    expect(url).toContain("observation=call-x");
  });
});

describe("UrlSelectionContext - detail tab sync", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/traces/run-1";
  });

  it("sets tab param via setDetailTab", () => {
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("set-tab-tokens").click());

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(lastReplaceUrl()).toContain("tab=tokens");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("preserves observation and view when updating tab", () => {
    searchParams = new URLSearchParams("observation=call-x&view=timeline");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("set-tab-tokens").click());

    const url = lastReplaceUrl();
    expect(url).toContain("tab=tokens");
    expect(url).toContain("observation=call-x");
    expect(url).toContain("view=timeline");
  });
});

describe("UrlSelectionContext - URL construction", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/traces/run-1";
  });

  it("preserves the current pathname in the replace URL", () => {
    pathname = "/project/test/traces/run-42";
    renderWithProvider(<Consumer />, "run-42");
    act(() => screen.getByTestId("select-call").click());

    expect(lastReplaceUrl()).toContain("/project/test/traces/run-42");
  });

  it("omits the query string entirely when no params remain", () => {
    searchParams = new URLSearchParams("observation=only-one");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("clear").click());

    expect(lastReplaceUrl()).toBe("/project/test/traces/run-1");
  });

  it("passes scroll:false option to router.replace", () => {
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("select-call").click());

    const options = replaceMock.mock.calls.at(-1)?.[1];
    expect(options).toEqual({ scroll: false });
  });
});

describe("UrlSelectionContext - throw outside provider", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/traces/run-1";
  });

  it("throws when useSelection is used outside provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<Consumer />);
    }).toThrow("useSelection must be used within SelectionProvider");

    consoleError.mockRestore();
  });
});
