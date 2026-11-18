import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readTaskDefinitionSourceMock = vi.hoisted(() => vi.fn());
const readTaskFileMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-task-api", () => ({
  readTaskDefinitionSource: readTaskDefinitionSourceMock,
  readTaskFile: readTaskFileMock,
}));

// Only the API boundary is mocked; the candidate ordering and the
// settled-state guard run for real.
import { useWholeFileSource } from "./use-whole-file-source";
import type {
  CheckResult,
  TaskDefinitionRevisionSummary,
  TaskFileContentResponse,
} from "@/lib/agent-task-api";

function file(path: string): TaskFileContentResponse {
  return {
    name: path,
    path,
    content: 'test("sample", (t) => { t.check(1, 1); });',
    size_bytes: 40,
    language: "typescript",
    lines: 2,
  };
}

const DEFINITION: TaskDefinitionRevisionSummary = {
  id: "rev-1",
  digest: "sha256:abc",
  created_at: "2026-11-18T10:00:00Z",
  files: [
    {
      path: "tasks/template/editing-content.task.yaml",
      language: "typescript",
      size_bytes: 120,
      lines: 6,
    },
  ],
};
const CHECK: CheckResult = { id: "sample", pass: true, reasoning: "" };
const TASK_ID = "template/editing-content";

function makeProps(overrides: Partial<Parameters<typeof useWholeFileSource>[0]> = {}) {
  return {
    open: true,
    checksSource: null,
    checks: [],
    taskDefinition: null,
    taskRunId: "run_1",
    taskId: TASK_ID,
    projectId: "proj-1",
    commitSha: null,
    sourceType: null,
    ...overrides,
  };
}

function renderSource(overrides: Partial<Parameters<typeof useWholeFileSource>[0]> = {}) {
  const props = makeProps(overrides);
  return renderHook((p: typeof props) => useWholeFileSource(p), { initialProps: props });
}

describe("useWholeFileSource", () => {
  beforeEach(() => {
    readTaskDefinitionSourceMock.mockReset();
    readTaskFileMock.mockReset();
  });

  it("fetches nothing while the disclosure is closed", () => {
    renderSource({ open: false });

    expect(readTaskDefinitionSourceMock).not.toHaveBeenCalled();
    expect(readTaskFileMock).not.toHaveBeenCalled();
  });

  it("passes the stock hook's result through without fetching", () => {
    const existing = file("editing-content.eval.ts");
    const { result } = renderSource({
      checksSource: existing,
      checks: [CHECK],
    });

    expect(result.current).toEqual({ source: existing, pending: false });
    expect(readTaskDefinitionSourceMock).not.toHaveBeenCalled();
    expect(readTaskFileMock).not.toHaveBeenCalled();
  });

  it("reads the pinned Task Definition when a run has zero checks", async () => {
    readTaskDefinitionSourceMock.mockResolvedValue(file("editing-content.task.yaml"));
    const { result } = renderSource({ taskDefinition: DEFINITION });

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(readTaskDefinitionSourceMock).toHaveBeenCalledWith(
      "run_1",
      "tasks/template/editing-content.task.yaml",
      expect.any(AbortSignal),
    );
    expect(result.current.source?.path).toBe("editing-content.task.yaml");
    expect(readTaskFileMock).not.toHaveBeenCalled();
  });

  it("walks the legacy candidates in convention order until one loads", async () => {
    readTaskFileMock.mockImplementation((_taskId: string, path: string) =>
      path === "editing-content.eval.ts"
        ? Promise.reject(new Error("404"))
        : Promise.resolve(file(path)),
    );
    const { result } = renderSource({ taskDefinition: null });

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(readTaskFileMock).toHaveBeenNthCalledWith(
      1,
      TASK_ID,
      "editing-content.eval.ts",
      "proj-1",
      undefined,
      expect.any(AbortSignal),
    );
    expect(readTaskFileMock).toHaveBeenNthCalledWith(
      2,
      TASK_ID,
      "task.ts",
      "proj-1",
      undefined,
      expect.any(AbortSignal),
    );
    expect(result.current.source?.path).toBe("task.ts");
  });

  it("settles as unavailable when every candidate fails, without refetching", async () => {
    readTaskFileMock.mockRejectedValue(new Error("404"));
    const props = makeProps({ taskDefinition: null });
    const { result, rerender } = renderHook(
      (p: typeof props) => useWholeFileSource(p),
      { initialProps: props },
    );

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.source).toBeNull();
    const callsAfterSettle = readTaskFileMock.mock.calls.length;

    rerender({ ...props });
    expect(readTaskFileMock.mock.calls.length).toBe(callsAfterSettle);
  });
});
