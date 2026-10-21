/**
 * The onboarding panel renders the agent-first handoff — one copy-prompt
 * button whose tooltip carries the exact server and project — above a
 * checklist derived from real signals, with the manual commands collapsed
 * for humans who'd rather work through it themselves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { OnboardingPanel } from "../OnboardingPanel";
import type { OnboardingSignals } from "../onboarding-steps";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ refresh: vi.fn() }),
}));

const signals: OnboardingSignals = {
  projectId: "abc123def456",
  publicUrl: "https://test-apo.online",
  hasTraces: true,
  traceService: "billing-api",
  traceCount: 11,
  cliConnected: true,
  publishedTasks: 0,
  recordedRuns: 0,
};

describe("OnboardingPanel", () => {
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    clipboardWrite.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWrite },
      configurable: true,
    });
  });

  it("renders the copy-prompt handoff with the exact server and project", () => {
    render(<OnboardingPanel signals={signals} />);

    const button = screen.getByRole("button", {
      name: /copy prompt for your agent/i,
    });
    fireEvent.focus(button);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("https://test-apo.online");
    expect(tooltip.textContent).toContain("abc123def456");
    expect(tooltip.textContent).toContain(
      "apo login --backend https://test-apo.online --project abc123def456",
    );
  });

  it("copies the handoff prompt on click", () => {
    render(<OnboardingPanel signals={signals} />);

    fireEvent.click(
      screen.getByRole("button", { name: /copy prompt for your agent/i }),
    );

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const copied = clipboardWrite.mock.calls[0][0] as string;
    expect(copied).toContain("My apo server: https://test-apo.online");
    expect(copied).toContain("Report back");
  });

  it("renders the checklist from the signals", () => {
    render(<OnboardingPanel signals={signals} />);

    const list = screen.getByRole("list");
    expect(within(list).getByText("Signal Is Flowing")).toBeDefined();
    expect(screen.getByText("billing-api · 11 traces")).toBeDefined();
    expect(within(list).getByText("Connect The CLI")).toBeDefined();
    expect(within(list).getByText("Publish A Task Suite")).toBeDefined();
    expect(within(list).getByText("Record A Run")).toBeDefined();
  });

  it("lists the remaining steps' commands under the manual path", () => {
    render(<OnboardingPanel signals={signals} />);

    fireEvent.click(screen.getByText(/prefer doing it yourself\?/i));

    expect(screen.getByLabelText("Publish command")).toBeDefined();
    expect(screen.getByLabelText("Run command")).toBeDefined();
    // The CLI step is done — its commands stay hidden.
    expect(screen.queryByLabelText("Install CLI command")).toBeNull();
    expect(screen.queryByLabelText("Login command")).toBeNull();
  });

  it("falls back to the setup guide when the public URL is misconfigured", () => {
    render(<OnboardingPanel signals={{ ...signals, publicUrl: "" }} />);

    expect(
      screen.queryByRole("button", { name: /copy prompt for your agent/i }),
    ).toBeNull();
    expect(screen.getByText(/no public url configured/i)).toBeDefined();
    expect(
      screen.getByRole("link", { name: /setup guide/i }).getAttribute("href"),
    ).toMatch(/^https:\/\//);
  });
});
