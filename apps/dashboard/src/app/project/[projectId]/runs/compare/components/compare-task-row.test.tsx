import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AgentTaskRunDetail } from "@/lib/agent-task-api";

// Mock next/dynamic so it follows the loader: the stub renders nothing until
// the real (mocked) module resolves, then renders it with the props — so
// tests can capture what the lazily-loaded viewer receives (issue #178)
// while never pulling in CodeMirror.
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<unknown>) => {
    let Loaded: ((props: Record<string, unknown>) => ReactNode) | null = null;
    // Loaders may map the module (`m => m.CompareCodeViewer`, so loader()
    // resolves to the component itself) or return it whole.
    void loader().then((resolved) => {
      Loaded = (
        typeof resolved === "function"
          ? resolved
          : (resolved as Record<string, unknown>).CompareCodeViewer
      ) as typeof Loaded;
    });
    return function DynamicStub(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));

// Stub utility imports that CompareTaskRow pulls in but that aren't relevant
// to the evidence-loading behavior under test.
vi.mock("@/lib/load-check-source", () => ({
  loadCheckSource: vi.fn(),
}));
vi.mock("@/lib/agent-task-api", () => ({
  getAgentTaskRun: vi.fn(),
  readTaskDefinitionSource: vi.fn(),
  readTaskFile: vi.fn(),
}));

import { CompareTaskRow } from "./CompareTaskRow";
import type { ComparisonTask } from "../use-comparison";

// ─── helpers ──────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ComparisonTask> = {}): ComparisonTask {
  return {
    taskId: "task-1",
    label: "Task One",
    folder: "evals",
    differs: true,
    expandable: true,
    state: "aligned",
    left: { run: { id: "run-a", status: "passed", total_checks: 1, passed_checks: 1, failed_checks: 0 } as unknown as ComparisonTask["left"]["run"] },
    right: { run: { id: "run-b", status: "failed", total_checks: 1, passed_checks: 0, failed_checks: 1 } as unknown as ComparisonTask["right"]["run"] },
    ...overrides,
  };
}

const noopToggle = vi.fn();

// ─── tests ────────────────────────────────────────────────────────────────

describe("CompareTaskRow evidence loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state, then evidence when the loader resolves", async () => {
    const evidenceLoader = vi.fn().mockResolvedValue({
      left: { id: "run-a", checks_json: [] } as unknown,
      right: { id: "run-b", checks_json: [] } as unknown,
    });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
    });
    expect(evidenceLoader).toHaveBeenCalledOnce();
  });

  it("shows error and retry when the evidence loader rejects", async () => {
    const evidenceLoader = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue({ left: { id: "run-a", checks_json: [] }, right: { id: "run-b", checks_json: [] } });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    // Wait for the error state.
    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeInTheDocument();
    });

    // Retry button should be present.
    const retryButton = screen.getByText("Retry");
    expect(retryButton).toBeInTheDocument();

    // "Not run" must NOT appear — this is a load failure, not an absent side.
    // (The "Not run" text only appears in collapsed cells, which are separate
    // from the CheckDiff panel. But verify it doesn't leak.)
    expect(screen.queryAllByText("Not run")).toHaveLength(0);

    // Click retry → loader is called again.
    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(evidenceLoader).toHaveBeenCalledTimes(2);
    });
  });

  it("aborts the evidence request when the task collapses", async () => {
    let capturedSignal: AbortSignal | undefined;

    const evidenceLoader = vi.fn().mockImplementation(
      (_taskId: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never resolves — stays pending
      },
    );

    const { rerender } = render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    expect(evidenceLoader).toHaveBeenCalledOnce();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Collapse the task — CheckDiff unmounts, cleanup aborts.
    rerender(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set()}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    expect(capturedSignal!.aborted).toBe(true);
  });

  it("aborts stale evidence when switching to a different task", async () => {
    const signals: AbortSignal[] = [];

    const evidenceLoader = vi.fn().mockImplementation(
      (_taskId: string, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<{ left: unknown; right: unknown }>(() => {});
      },
    );

    const taskA = makeTask({ taskId: "task-a", label: "Alpha" });
    const taskB = makeTask({ taskId: "task-b", label: "Beta" });

    const { rerender } = render(
      <CompareTaskRow
        task={taskA}
        expanded={new Set(["task-a"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    // Switch to task B — task A's CheckDiff unmounts.
    rerender(
      <CompareTaskRow
        task={taskB}
        expanded={new Set(["task-b"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    // First signal (task A) should be aborted.
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].aborted).toBe(true);
  });

  it("does not render a truncated marker as [object Object]", async () => {
    const marker = {
      kind: "truncated" as const,
      preview: "the first 256 chars...",
      size_bytes: 50000,
      sha256: "abc123",
    };

    const evidenceLoader = vi.fn().mockResolvedValue({
      left: {
        id: "run-a",
        checks_json: [
          {
            id: "check-1",
            pass: false,
            name: "quality",
            assertions: [
              {
                id: "a1",
                pass: false,
                judge: {
                  prompt: { system: marker, user: "small" },
                  response: marker,
                },
              },
            ],
          },
        ],
      } as unknown as AgentTaskRunDetail,
      right: {
        id: "run-b",
        checks_json: [
          {
            id: "check-1",
            pass: true,
            name: "quality",
            assertions: [],
          },
        ],
      } as unknown as AgentTaskRunDetail,
    });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
    });

    // The marker should never appear as raw [object Object] text.
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("[object Object]");
  });
});

// ─── collapsed verdict cell ───────────────────────────────────────────────

type RunSummaryLike = NonNullable<ComparisonTask["left"]["run"]>;

function makeRun(
  id: string,
  passed: number,
  total: number,
  extra: Record<string, unknown> = {},
): RunSummaryLike {
  return {
    id,
    status: passed === total ? "passed" : "failed",
    total_checks: total,
    passed_checks: passed,
    failed_checks: total - passed,
    pass_result: passed === total,
    ...extra,
  } as unknown as RunSummaryLike;
}

describe("CompareTaskRow collapsed checks cell", () => {
  it("colours 58/60 as a failure and 60/60 as a pass, so near-identical scores never look the same", () => {
    render(
      <CompareTaskRow
        task={makeTask({ left: { run: makeRun("run-a", 58, 60) }, right: { run: makeRun("run-b", 60, 60) } })}
        expanded={new Set()}
        onToggleExpand={noopToggle}
        projectId="p1"
      />,
    );

    // The row renders each side twice (md+ cell and the narrow-screen stack).
    for (const el of screen.getAllByText("58/60")) {
      expect(el.className).toContain("text-destructive");
      expect(el.className).not.toContain("text-success");
    }
    for (const el of screen.getAllByText(/^60\/60/)) {
      expect(el.className).toContain("text-success");
    }

    // Only the side with failures gets a red segment in its bar.
    const failedSegments = screen.getAllByTestId("checks-bar-failed");
    expect(failedSegments).toHaveLength(2);
    for (const seg of failedSegments) {
      expect(seg.className).toContain("bg-destructive");
      // 2/60 would round to ~2px; the minimum width keeps the sliver visible.
      expect(seg.className).toContain("min-w-");
    }
    const passedSegments = screen.getAllByTestId("checks-bar-passed");
    expect(passedSegments.filter((s) => s.className.includes("bg-success"))).toHaveLength(2);
    expect(passedSegments.filter((s) => s.className.includes("bg-foreground/30"))).toHaveLength(2);

    // The right cell says what changed: B passed two more checks than A.
    expect(screen.getAllByText("(+2)")).toHaveLength(2);
  });

  it("keeps the score adjacent to the bar instead of flinging it to the cell's right edge", () => {
    // The count track is auto-width (so "60/60 (+2)" fits), but an auto grid
    // track stretches to absorb the cell's free space — without justify-start
    // the score detaches from its bar and lands at the far right of the column.
    render(
      <CompareTaskRow
        task={makeTask({ left: { run: makeRun("run-a", 58, 60) }, right: { run: makeRun("run-b", 60, 60) } })}
        expanded={new Set()}
        onToggleExpand={noopToggle}
        projectId="p1"
      />,
    );
    const cells = screen
      .getAllByTestId("checks-bar-passed")
      .map((seg) => seg.parentElement?.parentElement);
    expect(cells).toHaveLength(4); // md+ row + narrow stack, both sides
    for (const cell of cells) {
      expect(cell?.className).toContain("justify-start");
      expect(cell?.querySelector("span.font-mono")?.className).not.toContain("justify-self-end");
    }
  });

  it("shows a negative delta when the right side passed fewer checks", () => {
    render(
      <CompareTaskRow
        task={makeTask({ left: { run: makeRun("run-a", 60, 60) }, right: { run: makeRun("run-b", 57, 60) } })}
        expanded={new Set()}
        onToggleExpand={noopToggle}
        projectId="p1"
      />,
    );
    expect(screen.getAllByText("(−3)")).toHaveLength(2);
    for (const el of screen.getAllByText("(−3)")) {
      expect(el.className).toContain("text-destructive");
    }
  });

  it("shows no delta when both sides passed the same number of checks", () => {
    render(
      <CompareTaskRow
        task={makeTask({ differs: false, left: { run: makeRun("run-a", 58, 60) }, right: { run: makeRun("run-b", 58, 60) } })}
        expanded={new Set()}
        onToggleExpand={noopToggle}
        projectId="p1"
      />,
    );
    expect(screen.queryByText(/^\([+−]\d+\)$/)).toBeNull();
  });

  it("hides the count and delta when the two runs used different eval versions", () => {
    render(
      <CompareTaskRow
        task={makeTask({
          state: "different_definition",
          left: { run: makeRun("run-a", 10, 12) },
          right: { run: makeRun("run-b", 30, 32) },
        })}
        expanded={new Set()}
        onToggleExpand={noopToggle}
        projectId="p1"
      />,
    );
    expect(screen.queryByText("10/12")).toBeNull();
    expect(screen.queryByText(/^\([+−]\d+\)$/)).toBeNull();
  });

  it("uses the recorded task verdict over the check count when they disagree", () => {
    // Every check passed but the task was recorded as failed (e.g. a finish
    // check outside the counted checks). The verdict colour must follow the
    // recorded result, not the tally.
    render(
      <CompareTaskRow
        task={makeTask({
          left: { run: makeRun("run-a", 4, 4, { pass_result: false }) },
          right: { run: makeRun("run-b", 4, 4) },
        })}
        expanded={new Set()}
        onToggleExpand={noopToggle}
        projectId="p1"
      />,
    );
    const cells = screen.getAllByText(/^4\/4/);
    expect(cells.filter((c) => c.className.includes("text-destructive"))).toHaveLength(2);
    expect(cells.filter((c) => c.className.includes("text-success"))).toHaveLength(2);
  });
});

// ─── issue #309: reasoning + model-time metric rows ────────────────────────

describe("CompareTaskRow reasoning and model-time rows (issue #309)", () => {
  it("shows reasoning and model-time rows with linked max/slowest sub-lines", async () => {
    const evidenceLoader = vi.fn().mockResolvedValue({
      left: {
        id: "run-a",
        checks_json: [],
        trace_run_id: "trace-a",
        total_reasoning_tokens: 10_000,
        max_call_reasoning_tokens: 4_000,
        max_call_reasoning_call_id: "obs-a1",
        total_model_time_ms: 300_000,
        max_call_latency_ms: 120_000,
        max_call_latency_call_id: "obs-a2",
      },
      right: {
        id: "run-b",
        checks_json: [],
        trace_run_id: "trace-b",
        total_reasoning_tokens: 2_000,
        max_call_reasoning_tokens: 800,
        max_call_reasoning_call_id: "obs-b1",
        total_model_time_ms: 90_000,
        max_call_latency_ms: 30_000,
        max_call_latency_call_id: "obs-b2",
      },
    });
    render(
      <CompareTaskRow
        task={makeTask({
          left: { run: makeRun("run-a", 1, 1) },
          right: { run: makeRun("run-b", 0, 1) },
        })}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="p1"
        evidenceLoader={evidenceLoader}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
    });

    // Both new rows render with their formatted totals.
    expect(screen.getByText("reasoning")).toBeInTheDocument();
    expect(screen.getAllByText("10.0k tok").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2.0k tok").length).toBeGreaterThan(0);
    expect(screen.getByText("model time")).toBeInTheDocument();
    expect(screen.getAllByText("5m 00s").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1m 30s").length).toBeGreaterThan(0);

    // The max/slowest sub-lines deep-link to the winning observation.
    const maxLink = screen.getAllByText("max 4.0k tok")[0].closest("a");
    expect(maxLink?.getAttribute("href")).toBe("/project/p1/traces/trace-a?observation=obs-a1");
    const slowestLink = screen.getAllByText("slowest 2m 00s")[0].closest("a");
    expect(slowestLink?.getAttribute("href")).toBe("/project/p1/traces/trace-a?observation=obs-a2");
  });

  it("keeps unknown reasoning visibly distinct from a reported zero", async () => {
    const evidenceLoader = vi.fn().mockResolvedValue({
      left: {
        id: "run-a",
        checks_json: [],
        // Side A's provider reported a measurably-zero reasoning total.
        total_reasoning_tokens: 0,
        max_call_reasoning_tokens: 0,
      },
      right: {
        id: "run-b",
        checks_json: [],
        // Side B never reported the dimension — must render "—", not 0.
      },
    });
    render(
      <CompareTaskRow
        task={makeTask({
          left: { run: makeRun("run-a", 1, 1) },
          right: { run: makeRun("run-b", 0, 1) },
        })}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="p1"
        evidenceLoader={evidenceLoader}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
    });

    expect(screen.getByText("reasoning")).toBeInTheDocument();
    expect(screen.getAllByText("0 tok").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

// ─── issue #178: generated-title checks must show their own block ────────

// The file a real table-driven eval has: unrelated literal-title checks plus
// a forEach generating checks whose titles never appear literally in source.
const tableDrivenFile = `/** Template upload — Shareholders' Agreement checks. */
const PLACEHOLDER_TERMS: Term[] = [];

test("literal-title-check", (t, { deliverables }) => {
  t.check(unrelated(), satisfies(...));
});

PLACEHOLDER_TERMS.forEach((p) => {
  test(\`P-\${p.id} — a placeholder exists for \${p.label}\`, (t, { deliverables }) => {
    t.check(hasPlaceholderFor(p.id), satisfies(...));
  });
});
`;

// Captured props from the code viewer mock — the renderer under test.
let viewerProps: { code?: string; assertions?: Array<{ line: number; left?: boolean; right?: boolean }> } = {};

vi.mock("./CompareCodeViewer", () => ({
  CompareCodeViewer: (props: { code: string; assertions: unknown[] }) => {
    viewerProps = props as typeof viewerProps;
    return null;
  },
}));

import { loadCheckSource } from "@/lib/load-check-source";

describe("CompareTaskRow check source for generated-title checks (issue #178)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viewerProps = {};
  });

  it("shows the check's own block, with markers on its own t.check line", async () => {
    vi.mocked(loadCheckSource).mockResolvedValue({
      content: tableDrivenFile,
      language: "typescript",
    });
    const generatedTitle = "P-reg — a placeholder exists for the company registration number";
    const evidenceLoader = vi.fn().mockResolvedValue({
      left: {
        id: "run-a",
        checks_json: [
          {
            id: generatedTitle,
            pass: false,
            location: null,
            assertions: [{ id: "check", pass: false, location: { file: "shareholders-agreement.eval.ts", line: 10, column: 7 } }],
          },
        ],
      },
      right: {
        id: "run-b",
        checks_json: [
          {
            id: generatedTitle,
            pass: true,
            location: null,
            assertions: [{ id: "check", pass: true, location: { file: "shareholders-agreement.eval.ts", line: 10, column: 7 } }],
          },
        ],
      },
    });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    // Expand the check row (aria-label "Expand" on the chevron button).
    const expand = await screen.findByLabelText("Expand");
    fireEvent.click(expand);

    await waitFor(() => {
      expect(viewerProps.code).toBeTruthy();
    });

    // The check's own generated-title block — not the whole file.
    expect(viewerProps.code).toContain("P-${p.id}");
    expect(viewerProps.code).not.toContain("literal-title-check");
    expect(viewerProps.code).not.toContain("Template upload");

    // The ✓/✗ markers land on THIS check's t.check line (block line 2),
    // not on the unrelated literal-title check's line.
    const marker = viewerProps.assertions?.find((a) => a.left !== undefined || a.right !== undefined);
    expect(marker?.line).toBe(2);
    expect(marker?.left).toBe(false);
    expect(marker?.right).toBe(true);
  });
});

describe("CompareTaskRow run-level usage rows", () => {
  // Rollup fields on the run (issue #309 discrete columns, schema v47).
  const rollups = (
    modelMs: number | null,
    slowestMs: number | null,
    slowestId: string | null,
    reasoning: number | null,
    maxReasoning: number | null,
    maxReasoningId: string | null,
  ) => ({
    total_model_time_ms: modelMs,
    max_call_latency_ms: slowestMs,
    max_call_latency_call_id: slowestId,
    total_reasoning_tokens: reasoning,
    max_call_reasoning_tokens: maxReasoning,
    max_call_reasoning_call_id: maxReasoningId,
  });

  it("shows model time and reasoning rows with each side's values", async () => {
    const evidenceLoader = vi.fn().mockResolvedValue({
      left: { id: "run-a", checks_json: [], ...rollups(58_538, 7_419, "call-a-slow", 5_492, 1_054, "call-a-deep") },
      right: { id: "run-b", checks_json: [], ...rollups(142_000, 61_000, "call-b-slow", 24_100, 18_300, "call-b-deep") },
    });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("model time")).toBeInTheDocument();
    });
    expect(screen.getByText("reasoning")).toBeInTheDocument();
    expect(screen.getByText("58.54s")).toBeInTheDocument();
    expect(screen.getByText("2m 22s")).toBeInTheDocument();
    expect(screen.getByText("5.5k tok")).toBeInTheDocument();
    expect(screen.getByText("24.1k tok")).toBeInTheDocument();
    // The extremes ride as linked sub-lines, not separate rows.
    expect(screen.getByText("slowest 7.42s")).toBeInTheDocument();
    expect(screen.getByText("slowest 1m 01s")).toBeInTheDocument();
    expect(screen.queryByText("max reasoning/call")).not.toBeInTheDocument();
  });

  it("links the extreme sub-lines to the call that set them", async () => {
    const evidenceLoader = vi.fn().mockResolvedValue({
      left: {
        id: "run-a",
        trace_run_id: "trace-a",
        checks_json: [],
        ...rollups(9_000, 7_000, "span-left-slow", 900, 600, "span-left-deep"),
      },
      right: {
        id: "run-b",
        trace_run_id: "trace-b",
        checks_json: [],
        ...rollups(9_000, 7_000, "span-right-slow", 900, 600, "span-right-deep"),
      },
    });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    // Each side's extreme sub-lines deep-link to the observation behind the
    // max via the trace view's selection param (issue #309).
    await waitFor(() => {
      expect(screen.getByText("model time")).toBeInTheDocument();
    });
    const hrefs = screen
      .getAllByRole("link")
      .map((el) => el.getAttribute("href"));
    expect(hrefs).toContain("/project/proj/traces/trace-a?observation=span-left-slow");
    expect(hrefs).toContain("/project/proj/traces/trace-a?observation=span-left-deep");
    expect(hrefs).toContain("/project/proj/traces/trace-b?observation=span-right-slow");
    expect(hrefs).toContain("/project/proj/traces/trace-b?observation=span-right-deep");
  });

  it("leaves the reasoning rows out when neither side reported reasoning", async () => {
    const evidenceLoader = vi.fn().mockResolvedValue({
      left: { id: "run-a", checks_json: [], ...rollups(3_000, 2_000, "call", null, null, null) },
      right: { id: "run-b", checks_json: [], ...rollups(3_000, 2_000, "call", null, null, null) },
    });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("model time")).toBeInTheDocument();
    });
    expect(screen.queryByText("reasoning")).not.toBeInTheDocument();
  });
});
