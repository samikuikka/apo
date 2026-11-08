/**
 * Serving evidence on the Runs list (issue #307): the compact Serving cell
 * rides along only when the API carries summaries (old backends keep the
 * table unchanged), and the toolbar's Host/Route/Tier inputs write the
 * same-request serving filter params into the URL the page fetch reads.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RunsClient } from "@/app/project/[projectId]/runs/runs-client";
import type { AgentTaskBatchRunSummary, ModelFacetOption } from "@/lib/agent-task-api";

const replace = vi.fn();
let searchParams = new URLSearchParams();

// router.replace writes flow back into the mocked searchParams so a second
// filter commit sees the first one's param, like a real navigation would.
vi.mock("next/navigation", () => ({
  usePathname: () => "/project/acme/runs",
  useRouter: () => ({
    replace: (url: string) => {
      replace(url, { scroll: false });
      searchParams = new URLSearchParams(url.split("?")[1] ?? "");
    },
    refresh: vi.fn(),
    push: vi.fn(),
  }),
  useSearchParams: () => searchParams,
  useParams: () => ({ projectId: "acme" }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

vi.mock("@/components/agent-task-execution/runs-list-auto-refresh", () => ({
  RunsListAutoRefresh: () => null,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const modelFacets: ModelFacetOption[] = [];

function batch(overrides: Partial<AgentTaskBatchRunSummary> = {}): AgentTaskBatchRunSummary {
  return {
    id: "bch_1",
    project: "acme",
    selection_type: "all",
    selection_query: null,
    task_root: null,
    grep: null,
    environment: "default",
    status: "completed",
    total_tasks: 1,
    passed_tasks: 1,
    failed_tasks: 0,
    errored_tasks: 0,
    total_checks: 2,
    passed_checks: 2,
    created_at: "2026-09-14T00:00:00Z",
    started_at: "2026-09-14T00:00:00Z",
    completed_at: "2026-09-14T00:01:00Z",
    trigger: null,
    trace_persistence_status: "persisted",
    trace_error_message: null,
    total_cost: null,
    total_tokens: null,
    configuration: {
      state: "unknown",
      configurations: [],
      reported_task_runs: 0,
      total_task_runs: 1,
    },
    labels: {},
    ...overrides,
  };
}

function runsClientElement(list: AgentTaskBatchRunSummary[]) {
  return (
    <RunsClient
      batchRuns={list}
      error={null}
      taskSource={{ source_type: "published" } as never}
      totalCount={list.length}
      page={0}
      pageSize={20}
      totalPages={1}
      modelFacets={modelFacets}
      providerFacets={[]}
      labelFacets={null}
      canDeleteRuns={false}
    />
  );
}

function renderRuns(list: AgentTaskBatchRunSummary[], query = "") {
  searchParams = new URLSearchParams(query);
  return render(runsClientElement(list));
}

/** Wait out the serving inputs' 350 ms debounce (real timers, like typing). */
const settleDebounce = () => new Promise((resolve) => setTimeout(resolve, 450));

describe("Runs list serving wiring", () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it("renders the Serving column and compact cell when the list carries summaries", () => {
    renderRuns([
      batch({
        serving: {
          state: "uniform",
          calls: 2,
          errored_calls: 0,
          unknown_provider_calls: 0,
          unknown_host_calls: 0,
          aggregate_observations: 0,
          groups: [
            {
              identity: {
                model: "example-model",
                instrumentation_provider: null,
                api_provider: "fireworks",
                serving_host: null,
                route: null,
                requested_service_tier: null,
                service_tier: "priority",
                request_model: null,
                response_model: null,
                evidence: null,
              },
              calls: 2,
              errored_calls: 0,
              whole_call_rate: { median: 121.4, samples: 2 },
              streaming_rate: { median: null, samples: 0 },
              rate_scopes: [],
            },
          ],
          total_groups: 1,
          groups_truncated: false,
          task_runs_with_evidence: 1,
          task_runs_total: 1,
          cost_coverage: {
            reported: null,
            qualified_estimate: null,
            model_only_estimate: null,
            unpriced_calls: 0,
            ambiguous_calls: 0,
            excluded_error_calls: 0,
            aggregate_charge_observations: 0,
            partial: false,
          },
        },
      }),
    ]);
    expect(screen.getByText("Serving")).toBeInTheDocument();
    expect(screen.getByText("fireworks \u00b7 priority")).toBeInTheDocument();
  });

  it("omits the Serving column entirely on old-backend lists", () => {
    renderRuns([batch()]);
    expect(screen.queryByText("Serving")).not.toBeInTheDocument();
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });

  it("writes the serving filter params to the URL the list fetch reads", async () => {
    const user = userEvent.setup();
    const list = [batch()];
    const view = renderRuns(list);
    await user.type(screen.getByTestId("serving-filter-host"), "baseten");
    await settleDebounce();
    expect(replace).toHaveBeenLastCalledWith("/project/acme/runs?host=baseten", {
      scroll: false,
    });

    // A real navigation re-renders the client with the new params; mirror
    // that before the second dimension commits so it builds on the first.
    replace.mockClear();
    view.rerender(runsClientElement(list));
    await user.type(screen.getByTestId("serving-filter-tier"), "priority");
    await settleDebounce();
    expect(replace).toHaveBeenLastCalledWith(
      "/project/acme/runs?host=baseten&tier=priority",
      { scroll: false },
    );
  });

  it("clears the serving filters with Clear Filters", async () => {
    const user = userEvent.setup();
    renderRuns([batch({ serving: undefined })], "host=baseten&route=nitro&status=failed");
    // The carried-in serving filters count as active, so the affordance exists.
    const clear = await screen.findByTestId("runs-clear-filters");
    await user.click(clear);
    expect(replace).toHaveBeenLastCalledWith("/project/acme/runs", { scroll: false });
  });
});
