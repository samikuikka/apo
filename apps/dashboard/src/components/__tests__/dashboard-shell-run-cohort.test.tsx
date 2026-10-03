/**
 * The cohort handoff between Tasks and Runs.
 *
 * A Tasks page narrowed to one model used to land on the unfiltered run list,
 * leaving the same model/effort/date filters to be re-picked by hand. The page
 * showing a cohort publishes it, and the Runs nav link carries it as the query
 * params that page already reads.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DashboardShell } from "../dashboard-shell";
import type { RunCohort } from "@/lib/run-cohort";
import { usePublishRunCohort } from "@/lib/run-cohort-context";

// The shell reads the session to hide switcher chrome for anonymous demo
// visitors; these tests exercise cohort handoff, not sessions.
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated", data: null }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/project/acme/tasks",
}));

vi.mock("@/components/project-switcher", () => ({
  ProjectSwitcher: () => <div data-testid="project-switcher" />,
}));

function Publisher({ cohort }: { cohort: RunCohort }) {
  usePublishRunCohort(cohort);
  return <div data-testid="page" />;
}

function renderShell(children: React.ReactNode) {
  return render(<DashboardShell projectId="acme">{children}</DashboardShell>);
}

const navHref = (label: string) =>
  screen.getByRole("link", { name: label }).getAttribute("href");

describe("Runs nav link", () => {
  it("stays plain when the page publishes nothing", () => {
    renderShell(<div />);
    expect(navHref("Runs")).toBe("/project/acme/runs");
  });

  it("stays plain for an all-history view", () => {
    renderShell(
      <Publisher cohort={{ model: null, effort: null, since: null, provider: null }} />,
    );
    expect(navHref("Runs")).toBe("/project/acme/runs");
  });

  it("carries the published model, effort, and date window", () => {
    renderShell(
      <Publisher
        cohort={{ model: "claude-opus-5", effort: "high", since: "5d", provider: null }}
      />,
    );
    expect(navHref("Runs")).toBe(
      "/project/acme/runs?model=claude-opus-5&effort=high&since=5d",
    );
  });

  it("carries only the dimensions the view narrows", () => {
    renderShell(
      <Publisher cohort={{ model: "kimi-k3", effort: null, since: null, provider: null }} />,
    );
    expect(navHref("Runs")).toBe("/project/acme/runs?model=kimi-k3");
  });

  it("encodes model ids that carry a provider prefix", () => {
    renderShell(
      <Publisher
        cohort={{ model: "pi:openai/gpt-5.6", effort: null, since: null, provider: null }}
      />,
    );
    expect(navHref("Runs")).toBe(
      "/project/acme/runs?model=pi%3Aopenai%2Fgpt-5.6",
    );
  });

  it("follows the published cohort as the view changes", () => {
    const { rerender } = renderShell(
      <Publisher cohort={{ model: "kimi-k3", effort: null, since: null, provider: null }} />,
    );
    rerender(
      <DashboardShell projectId="acme">
        <Publisher
          cohort={{ model: "claude-opus-5", effort: null, since: "7d", provider: null }}
        />
      </DashboardShell>,
    );
    expect(navHref("Runs")).toBe(
      "/project/acme/runs?model=claude-opus-5&since=7d",
    );
  });

  it("drops the cohort once the publishing page unmounts", () => {
    const { rerender } = renderShell(
      <Publisher cohort={{ model: "kimi-k3", effort: null, since: null, provider: null }} />,
    );
    rerender(<DashboardShell projectId="acme">{<div />}</DashboardShell>);
    expect(navHref("Runs")).toBe("/project/acme/runs");
  });

  it("leaves the other destinations alone", () => {
    renderShell(
      <Publisher cohort={{ model: "kimi-k3", effort: "high", since: "7d", provider: null }} />,
    );
    expect(navHref("Tasks")).toBe("/project/acme/tasks");
    expect(navHref("Schedules")).toBe("/project/acme/schedules");
    expect(navHref("Traces")).toBe("/project/acme/traces");
  });
});
