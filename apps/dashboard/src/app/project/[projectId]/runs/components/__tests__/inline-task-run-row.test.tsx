/**
 * Scope loop, Runs-page side: run-row links forward the page's URL
 * cohort into run detail, using the drill-down vocabulary (single model only).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { InlineTaskRunRow } from "../InlineTaskRunRow";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";

let searchParams: URLSearchParams;

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useSearchParams: () => searchParams,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  };
});

const run = {
  id: "run_abc",
  task_id: "support/refund",
  adapter_name: "claude-code",
  status: "passed",
  run_configuration: { model: "claude-opus-5" },
} as unknown as AgentTaskRunSummary;

beforeEach(() => {
  searchParams = new URLSearchParams();
});

describe("InlineTaskRunRow cohort forwarding", () => {
  it("forwards a single-model page filter into the run link", () => {
    searchParams = new URLSearchParams("model=claude-opus-5&since=7d");
    render(<InlineTaskRunRow run={run} projectId="acme" clientNow={null} canDelete={false} onDeleted={() => {}} />);
    expect(screen.getByRole("link", { name: "support/refund" })).toHaveAttribute(
      "href",
      "/project/acme/runs/task/run_abc?model=claude-opus-5&since=7d",
    );
  });

  it("drops an ambiguous multi-model filter instead of mangling it", () => {
    searchParams = new URLSearchParams("model=claude-opus-5,deepseek-v4");
    render(<InlineTaskRunRow run={run} projectId="acme" clientNow={null} canDelete={false} onDeleted={() => {}} />);
    expect(screen.getByRole("link", { name: "support/refund" })).toHaveAttribute(
      "href",
      "/project/acme/runs/task/run_abc",
    );
  });

  it("leaves links plain without any page filter", () => {
    render(<InlineTaskRunRow run={run} projectId="acme" clientNow={null} canDelete={false} onDeleted={() => {}} />);
    expect(screen.getByRole("link", { name: "support/refund" })).toHaveAttribute(
      "href",
      "/project/acme/runs/task/run_abc",
    );
  });
});

describe("InlineTaskRunRow serving hosts (issue #307)", () => {
  it("renders the run's host labels in the Hosts cell", () => {
    const hostRun = {
      id: "run_fw",
      task_id: "code-review",
      status: "passed",
      run_configuration: { model: "deepseek-v4.1-flash" },
      model_providers: [
        { model: "deepseek-v4.1-flash", provider: "openrouter", route: "openrouter:nitro", calls: 2, total_tokens: 1, cost_micro: 1 },
      ],
    } as unknown as AgentTaskRunSummary;
    render(
      <InlineTaskRunRow
        run={hostRun}
        projectId="p"
        clientNow={null}
        canDelete={false}
        onDeleted={() => {}}
      />,
    );
    expect(screen.getAllByText("openrouter:nitro").length).toBeGreaterThan(0);
  });

  it("renders an em dash when no host was reported", () => {
    const legacyRun = {
      id: "run_old",
      task_id: "code-review",
      status: "passed",
      run_configuration: { model: "gpt-5.6-terra" },
    } as unknown as AgentTaskRunSummary;
    const { container } = render(
      <InlineTaskRunRow
        run={legacyRun}
        projectId="p"
        clientNow={null}
        canDelete={false}
        onDeleted={() => {}}
      />,
    );
    expect(container.textContent).toContain("—");
  });
});
