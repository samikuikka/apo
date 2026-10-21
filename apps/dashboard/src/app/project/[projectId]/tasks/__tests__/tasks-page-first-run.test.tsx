/**
 * Real-page scene: the registered Tasks server page itself — not just the
 * isolated component — carries the agent-first onboarding panel for a
 * Project with no recorded runs, embeds the exact hosted login command in
 * the handoff prompt, keeps the panel after Tasks are published (a
 * half-finished setup keeps its map), and replaces it with normal product
 * once a Run is recorded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/agent-task-api", () => ({
  listProjectAgentTasks: vi.fn().mockResolvedValue([]),
  listArchivedAgentTasks: vi.fn().mockResolvedValue([]),
  archivedTaskToSummary: (entry: { task_id: string; display_name: string; folder_path: string; task_path: string; run_stats: unknown }) => ({
    id: entry.task_id,
    task_path: entry.task_path,
    folder_path: entry.folder_path,
    display_name: entry.display_name,
    adapter_name: "unknown",
    has_checks: false,
    tags: [],
    run_stats: entry.run_stats as never,
    state: "removed" as const,
  }),
}));

vi.mock("@/lib/agent-task-view-api", () => ({
  fetchSavedViews: vi.fn().mockResolvedValue([]),
  fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([]),
  fetchTaskViewStats: vi.fn().mockResolvedValue({}),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "abc123def456" }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "abc123def456",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/projects-api", () => ({
  getProject: vi.fn().mockResolvedValue({
    id: "abc123def456",
    name: "Fresh Project",
    task_source: null,
  }),
  getProjectOnboardingStatus: vi.fn(),
}));

import {
  getProject,
  getProjectOnboardingStatus,
} from "@/lib/projects-api";
import { listProjectAgentTasks } from "@/lib/agent-task-api";
import AgentTasksPage from "../page";

async function renderPage() {
  const ui = await AgentTasksPage({
    params: Promise.resolve({ projectId: "abc123def456" }),
    searchParams: Promise.resolve({}),
  });
  return render(ui);
}

describe("Tasks page first-run", () => {
  beforeEach(() => {
    vi.mocked(getProject).mockResolvedValue({
      id: "abc123def456",
      name: "Fresh Project",
      task_source: null,
    } as Awaited<ReturnType<typeof getProject>>);
    vi.mocked(listProjectAgentTasks).mockResolvedValue([]);
  });

  it("renders the agent handoff with the exact hosted command for a virgin invited Project", async () => {
    vi.mocked(getProjectOnboardingStatus).mockResolvedValue({
      published_task_count: 0,
      recorded_run_count: 0,
      public_url: "https://test-apo.online",
    });

    await renderPage();

    expect(screen.getByText(/get to your first verdict/i)).toBeDefined();
    expect(
      screen.getByRole("button", { name: /copy prompt for your agent/i }),
    ).toBeDefined();
    expect(
      screen.getAllByText(
        "apo login --backend https://test-apo.online --project abc123def456",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("replaces onboarding with normal product after a recorded Run", async () => {
    vi.mocked(getProjectOnboardingStatus).mockResolvedValue({
      published_task_count: 0,
      recorded_run_count: 1,
      public_url: "https://test-apo.online",
    });

    await renderPage();

    expect(screen.queryByText(/get your first recorded run/i)).toBeNull();
    expect(screen.queryByText(/apo login/)).toBeNull();
  });

  it("keeps the onboarding panel after Tasks are published, until a run is recorded", async () => {
    vi.mocked(getProjectOnboardingStatus).mockResolvedValue({
      published_task_count: 3,
      recorded_run_count: 0,
      public_url: "https://test-apo.online",
    });

    await renderPage();

    expect(screen.getByText(/get to your first verdict/i)).toBeDefined();
  });

  it("never falls back to localhost when the origin is invalid", async () => {
    vi.mocked(getProjectOnboardingStatus).mockResolvedValue({
      published_task_count: 0,
      recorded_run_count: 0,
      public_url: null,
    });

    await renderPage();

    expect(screen.getByText(/no public url configured/i)).toBeDefined();
    expect(screen.queryByText(/apo login/)).toBeNull();
  });
});
