/**
 * The Runs page's server fetch must carry the URL's metric ranges to the
 * list API: the rail only writes params, the page is what applies them, and
 * a param the page forgets filters nothing while its chip claims otherwise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return {
    ...actual,
    listAgentTaskBatchRuns: vi.fn().mockResolvedValue({
      data: [],
      total_count: 0,
      page: 0,
      page_size: 20,
      total_pages: 0,
      model_facets: [],
      provider_facets: [],
    }),
    fetchRunLabelFacets: vi.fn().mockResolvedValue({ environments: [], labels: [] }),
  };
});

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>(
    "@/lib/projects-api",
  );
  return {
    ...actual,
    getProject: vi.fn().mockResolvedValue({
      id: "acme",
      name: "acme",
      role: "owner",
      created_at: "2026-01-01T00:00:00Z",
      can_run_tasks: true,
      can_delete_runs: true,
      is_demo: false,
    }),
  };
});

import { listAgentTaskBatchRuns } from "@/lib/agent-task-api";
import RunsPage from "../page";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Runs page metric ranges", () => {
  it("forwards cost and duration bounds from the URL to the list API", async () => {
    await RunsPage({
      params: Promise.resolve({ projectId: "acme" }),
      searchParams: Promise.resolve({ cost_min: "0.25", duration_max: "120" }),
    });

    expect(listAgentTaskBatchRuns).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ cost_min: 0.25, duration_max: 120 }),
    );
  });

  it("sends no bounds when the URL carries none", async () => {
    await RunsPage({
      params: Promise.resolve({ projectId: "acme" }),
      searchParams: Promise.resolve({}),
    });

    const opts = vi.mocked(listAgentTaskBatchRuns).mock.calls[0][1];
    // metricQuery yields undefined bounds, which the query layer drops.
    expect(opts?.cost_min).toBeUndefined();
    expect(opts?.duration_max).toBeUndefined();
  });
});
