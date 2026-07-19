import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => searchParams,
  usePathname: () => "/project/test/traces/run-1",
}));

import { TraceLayoutMobile } from "../TraceLayoutMobile";
import { SelectionProvider, useSelection } from "../contexts/SelectionContext";
import { UrlSelectionProvider } from "../contexts/UrlSelectionContext";

const TABS_TEXT = "View mode tabs";
const NAV_TEXT = "Tree navigation content";
const DETAIL_TEXT = "Call detail content";

/** Drives `selectCall` from inside a SelectionProvider tree. */
function SelectCallTrigger({ callId }: { callId: string }) {
  const { selectCall } = useSelection();
  return (
    <button type="button" data-testid="select-call" onClick={() => selectCall(callId)}>
      select {callId}
    </button>
  );
}

function renderMobile(children: React.ReactNode) {
  return render(<SelectionProvider>{children}</SelectionProvider>);
}

function mobileLayout() {
  return (
    <TraceLayoutMobile
      tabs={<div>{TABS_TEXT}</div>}
      navContent={<div>{NAV_TEXT}</div>}
      detailContent={<div>{DETAIL_TEXT}</div>}
    />
  );
}

describe("TraceLayoutMobile - rendering", () => {
  it("renders tabs, nav content, and detail content", () => {
    renderMobile(mobileLayout());
    expect(screen.getByText(TABS_TEXT)).toBeInTheDocument();
    expect(screen.getByText(NAV_TEXT)).toBeInTheDocument();
    expect(screen.getByText(DETAIL_TEXT)).toBeInTheDocument();
  });

  it("starts with nav expanded (max 40vh) and a 'Hide navigation' toggle", () => {
    renderMobile(mobileLayout());
    const toggle = screen.getByRole("button", { name: /hide navigation/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const navSection = screen.getByLabelText("Trace navigation");
    expect(navSection.className).toContain("max-h-[40vh]");
  });

  it("keeps the tab bar visible after collapsing nav", async () => {
    const user = userEvent.setup();
    renderMobile(mobileLayout());
    await user.click(screen.getByRole("button", { name: /hide navigation/i }));
    expect(screen.getByText(TABS_TEXT)).toBeInTheDocument();
    expect(screen.getByText(DETAIL_TEXT)).toBeInTheDocument();
  });
});

describe("TraceLayoutMobile - collapse/expand toggle", () => {
  it("collapses nav to a thin bar when toggled", async () => {
    const user = userEvent.setup();
    renderMobile(mobileLayout());

    await user.click(screen.getByRole("button", { name: /hide navigation/i }));

    const toggle = screen.getByRole("button", { name: /show navigation/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    const navSection = screen.getByLabelText("Trace navigation");
    expect(navSection.className).toContain("max-h-12");
  });

  it("re-expands nav when toggled a second time", async () => {
    const user = userEvent.setup();
    renderMobile(mobileLayout());

    await user.click(screen.getByRole("button", { name: /hide navigation/i }));
    await user.click(screen.getByRole("button", { name: /show navigation/i }));

    const toggle = screen.getByRole("button", { name: /hide navigation/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

describe("TraceLayoutMobile - selection auto-collapse", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
  });

  it("auto-collapses nav when a node is selected", async () => {
    const user = userEvent.setup();
    renderMobile(
      <>
        {mobileLayout()}
        <SelectCallTrigger callId="call-1" />
      </>,
    );

    expect(screen.getByRole("button", { name: /hide navigation/i })).toBeInTheDocument();

    await user.click(screen.getByTestId("select-call"));

    expect(screen.getByRole("button", { name: /show navigation/i })).toBeInTheDocument();
  });

  it("keeps nav expanded on mount when a call is pre-selected via URL", () => {
    searchParams = new URLSearchParams("observation=call-preselected");
    render(
      <UrlSelectionProvider runId="run-1">{mobileLayout()}</UrlSelectionProvider>,
    );

    expect(screen.getByRole("button", { name: /hide navigation/i })).toBeInTheDocument();
  });
});

describe("TraceLayoutMobile - touch targets", () => {
  it("toggle button meets the 44px minimum touch target", () => {
    renderMobile(mobileLayout());
    const toggle = screen.getByRole("button", { name: /hide navigation/i });
    expect(toggle.className).toContain("min-h-11");
  });
});
