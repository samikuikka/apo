import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const replaceMock = vi.fn();
const pushMock = vi.fn();
let searchParams: URLSearchParams;
let pathname: string;

vi.mock("next/navigation", () => ({
  // Forward all args (url + options) so tests can assert e.g. { scroll: false }.
  useRouter: () => ({
    replace: (...args: unknown[]) => replaceMock(...args),
    push: (...args: unknown[]) => pushMock(...args),
  }),
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
}));

import { useUrlParam, useUrlParamSet } from "../use-url-state";

function lastReplaceUrl(): string {
  const last = replaceMock.mock.calls.at(-1);
  return last ? (last[0] as string) : "";
}

function lastReplaceOptions() {
  return replaceMock.mock.calls.at(-1)?.[1];
}

/**
 * Make router.replace behave like Next.js: after a replace, the next read of
 * useSearchParams() should reflect the new query string. The real hook rebuilds
 * URLSearchParams from the current search params each render, so a sequence of
 * interactions (e.g. toggling two items) accumulates correctly only if the mock
 * advances searchParams the way the router would.
 */
function syncSearchParamsOnReplace() {
  replaceMock.mockImplementation((url: string) => {
    const qIndex = url.indexOf("?");
    searchParams = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : "");
  });
}

// Note: the mock advances searchParams after a replace, but jsdom won't
// re-render the component the way Next.js does. So tests that need a sequence
// of interactions should seed the URL with the prior state instead of relying
// on a prior click to persist it. The hook accumulates within a single render
// correctly (it rebuilds the set from the current URL each call), so seeding
// is faithful to real behavior.

/** Extract the value(s) of one param from the last replaced URL. */
function paramFromLastUrl(key: string): string {
  const url = lastReplaceUrl();
  const qIndex = url.indexOf("?");
  const params = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : "");
  return params.get(key) ?? "";
}

// ── useUrlParam ──────────────────────────────────────────────────────────

function ParamConsumer({ paramKey, fallback }: { paramKey: string; fallback?: string }) {
  const [value, setValue] = useUrlParam(paramKey, fallback);
  return (
    <div>
      <span data-testid="value">{value}</span>
      <button type="button" data-testid="set" onClick={() => setValue("next")} />
      <button type="button" data-testid="clear" onClick={() => setValue(null)} />
    </div>
  );
}

describe("useUrlParam - initial state from URL", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/runs/run-1";
  });

  it("reads value from URL on mount", () => {
    searchParams = new URLSearchParams("q=hello");
    render(<ParamConsumer paramKey="q" />);
    expect(screen.getByTestId("value").textContent).toBe("hello");
  });

  it("falls back to empty when param absent", () => {
    render(<ParamConsumer paramKey="q" />);
    expect(screen.getByTestId("value").textContent).toBe("");
  });

  it("honors a provided fallback", () => {
    render(<ParamConsumer paramKey="filter" fallback="all" />);
    expect(screen.getByTestId("value").textContent).toBe("all");
  });
});

describe("useUrlParam - writes sync URL via router.replace", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/runs/run-1";
    syncSearchParamsOnReplace();
  });

  it("sets the param and uses replace (not push)", () => {
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("set").click());

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(lastReplaceUrl()).toContain("q=next");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("removes the param when set to null", () => {
    searchParams = new URLSearchParams("q=stale");
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("clear").click());

    expect(lastReplaceUrl()).not.toContain("q=");
  });

  it("preserves other params when writing", () => {
    searchParams = new URLSearchParams("filter=failed&tab=checks");
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("set").click());

    const url = lastReplaceUrl();
    expect(url).toContain("q=next");
    expect(url).toContain("filter=failed");
    expect(url).toContain("tab=checks");
  });

  it("passes scroll:false to avoid viewport jumps", () => {
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("set").click());
    expect(lastReplaceOptions()).toEqual({ scroll: false });
  });

  it("keeps pathname in the replace URL", () => {
    pathname = "/project/p1/runs/task/abc";
    render(<ParamConsumer paramKey="tab" />);
    act(() => screen.getByTestId("set").click());
    expect(lastReplaceUrl()).toContain("/project/p1/runs/task/abc");
  });

  it("omits query string entirely when no params remain", () => {
    searchParams = new URLSearchParams("q=only");
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("clear").click());
    expect(lastReplaceUrl()).toBe("/project/test/runs/run-1");
  });
});

// ── useUrlParamSet ───────────────────────────────────────────────────────

function SetConsumer({ paramKey }: { paramKey: string }) {
  const [set, toggle] = useUrlParamSet(paramKey);
  return (
    <div>
      <span data-testid="set">{Array.from(set).join(",")}</span>
      <button type="button" data-testid="add-a" onClick={() => toggle("a")} />
      <button type="button" data-testid="add-b" onClick={() => toggle("b")} />
      <button type="button" data-testid="remove-a" onClick={() => toggle("a", false)} />
      <button type="button" data-testid="force-add-a" onClick={() => toggle("a", true)} />
    </div>
  );
}

describe("useUrlParamSet - reads comma-separated values from URL", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/runs/task/x";
  });

  it("parses multiple values from URL on mount", () => {
    searchParams = new URLSearchParams("check=a,b,c");
    render(<SetConsumer paramKey="check" />);
    expect(screen.getByTestId("set").textContent).toBe("a,b,c");
  });

  it("starts empty when param absent", () => {
    render(<SetConsumer paramKey="check" />);
    expect(screen.getByTestId("set").textContent).toBe("");
  });

  it("trims whitespace and ignores empty entries", () => {
    searchParams = new URLSearchParams("check= a ,,b,");
    render(<SetConsumer paramKey="check" />);
    expect(screen.getByTestId("set").textContent).toBe("a,b");
  });
});

describe("useUrlParamSet - toggle writes to URL", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    pathname = "/project/test/runs/task/x";
    syncSearchParamsOnReplace();
  });

  it("adds a value via toggle (replace, not push)", () => {
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("add-a").click());

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(lastReplaceUrl()).toContain("check=a");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("adds multiple values to the same param", () => {
    // Seed "a" already in the URL, then add "b". A single render must combine
    // the existing URL value with the new toggle (jsdom won't re-render between
    // clicks the way Next.js does; seeding mirrors the real re-rendered state).
    searchParams = new URLSearchParams("check=a");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("add-b").click());

    // Both values land in the single check param, comma-separated.
    expect(paramFromLastUrl("check")).toBe("a,b");
  });

  it("removes a value when toggled off", () => {
    searchParams = new URLSearchParams("check=a,b");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("add-a").click());

    expect(paramFromLastUrl("check")).toBe("b");
  });

  it("respects explicit open=false", () => {
    searchParams = new URLSearchParams("check=a");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("remove-a").click());
    expect(lastReplaceUrl()).not.toContain("check=");
  });

  it("respects explicit open=true even if already present", () => {
    searchParams = new URLSearchParams("check=a");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("force-add-a").click());
    expect(paramFromLastUrl("check")).toBe("a");
  });

  it("preserves other params", () => {
    searchParams = new URLSearchParams("tab=checks&other=1");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("add-a").click());

    const url = lastReplaceUrl();
    expect(url).toContain("check=a");
    expect(url).toContain("tab=checks");
    expect(url).toContain("other=1");
  });
});
