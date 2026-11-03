import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getBrowserBackendBaseUrl: () => "http://backend.test",
  getProjectId: () => "proj-1",
}));

vi.mock("@/lib/backend-fetch", () => ({
  toBrowserProxyUrl: (url: string) => url,
}));

import { useRunEvents } from "../use-run-events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function Consumer({ onReconnect, onOpen }: { onReconnect: () => void; onOpen?: () => void }) {
  useRunEvents({
    project: "proj-1",
    enabled: true,
    onEvent: () => {},
    onReconnect,
    onOpen,
  });
  return null;
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

describe("useRunEvents reconnect notification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    setDocumentHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setDocumentHidden(false);
  });

  it("does not fire onReconnect for the first successful open", () => {
    const onReconnect = vi.fn();
    render(<Consumer onReconnect={onReconnect} />);

    act(() => FakeEventSource.instances[0].onopen?.());
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("fires onOpen on the first open and on every reopen", () => {
    const onOpen = vi.fn();
    render(<Consumer onReconnect={vi.fn()} onOpen={onOpen} />);

    act(() => FakeEventSource.instances[0].onopen?.());
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => FakeEventSource.instances[0].onerror?.());
    act(() => vi.advanceTimersByTime(3_000));
    act(() => FakeEventSource.instances[1].onopen?.());
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("fires onReconnect when the stream reopens after a drop", () => {
    const onReconnect = vi.fn();
    render(<Consumer onReconnect={onReconnect} />);

    act(() => FakeEventSource.instances[0].onopen?.());
    act(() => FakeEventSource.instances[0].onerror?.());
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => FakeEventSource.instances[1].onopen?.());
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // A stable connection must not keep reporting reconnects.
    act(() => FakeEventSource.instances[1].onopen?.());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("revives a dead stream when the tab becomes visible again", () => {
    const onReconnect = vi.fn();
    render(<Consumer onReconnect={onReconnect} />);

    act(() => FakeEventSource.instances[0].onopen?.());

    // Drop, then exhaust the backoff budget so the hook gives up entirely
    // (each retry connects but errors before opening).
    for (let attempt = 0; attempt < 6; attempt++) {
      const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
      act(() => es.onerror?.());
      act(() => vi.advanceTimersByTime(15_000));
    }
    const dead = FakeEventSource.instances.length;
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(dead);

    // Coming back to the tab reconnects from a clean slate...
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeEventSource.instances).toHaveLength(dead + 1);

    // ...and the open is reported as a reconnect so the page re-fetches
    // whatever it missed while the stream was down.
    act(() =>
      FakeEventSource.instances[FakeEventSource.instances.length - 1].onopen?.(),
    );
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
