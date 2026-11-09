/**
 * The layout must fetch label facets by the ROUTE project. The first
 * version read the `?project=` query param, which the Traces page never
 * has, so the facets never loaded and the whole Run labels group stayed
 * hidden on the real page while every unit-level test stayed green.
 */

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/project/acme/traces",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  // Deliberately empty: the page's project lives in the path, not here.
  useSearchParams: () => new URLSearchParams(""),
  useParams: () => ({ projectId: "acme" }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme",
  useIsDemo: () => false,
}));

vi.mock("@/hooks/use-filters", () => ({
  hasActiveFilters: () => false,
  useFilters: () => [
    { timePreset: "all", tags: [], models: [], providers: [], span_predicates: [], labels: {} },
    {
      setTimePreset: vi.fn(),
      setCustomTimeRange: vi.fn(),
      setProject: vi.fn(),
      setTaskId: vi.fn(),
      setEnvironment: vi.fn(),
      setLabels: vi.fn(),
      setSessionId: vi.fn(),
      setTags: vi.fn(),
      setModels: vi.fn(),
      setProviders: vi.fn(),
      setMetricFilter: vi.fn(),
      setSearch: vi.fn(),
      setSpanSearch: vi.fn(),
      setSpanPredicates: vi.fn(),
      setDurationRange: vi.fn(),
      clearAllFilters: vi.fn(),
      removeFilter: vi.fn(),
    },
  ],
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return {
    ...actual,
    fetchRunLabelFacets: vi.fn().mockResolvedValue({ environments: [], labels: [] }),
  };
});

import { fetchRunLabelFacets } from "@/lib/agent-task-api";
import { TracesPageLayout } from "@/components/trace-detail/layout/TracesPageLayout";

describe("Traces page label facets source", () => {
  it("fetches by the route project even without a ?project= param", async () => {
    render(
      <TracesPageLayout>
        <div>table</div>
      </TracesPageLayout>,
    );
    await waitFor(() => {
      expect(fetchRunLabelFacets).toHaveBeenCalledWith("acme");
    });
  });
});
