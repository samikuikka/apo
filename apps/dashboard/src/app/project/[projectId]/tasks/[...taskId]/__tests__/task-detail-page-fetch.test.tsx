/**
 * The task detail page's data fetch shape.
 *
 * One bounded list call serves the page: the scoped cohort at an explicit
 * page-aligned limit, and no unfiltered twin fetch for a count denominator
 * (that second 1,000-row scan per view was the read-hygiene problem). Task
 * resolution goes through the inventory's exact `ids` filter, so the page
 * never asks for the whole inventory with a substring `grep`.
 *
 * React's `cache` only memoizes inside a real request render (the RSC
 * runtime), so these tests pin each render half's request shape rather
 * than a cross-half fetch count.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listTaskRunsMock = vi.fn().mockResolvedValue([]);

vi.mock("next/navigation", () => ({
  usePathname: () => "/project/acme/tasks/t/1",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/agent-task-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-task-api")>()),
  listTaskRuns: (...args: unknown[]) => listTaskRunsMock(...(args as [])),
  fetchRunLabelFacets: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/agent-task-view-api", () => ({
  fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/projects-api", () => ({
  getProject: vi.fn().mockResolvedValue(null),
}));

import TaskDetailPage, { generateMetadata } from "../page";

afterEach(() => {
  vi.unstubAllGlobals();
});

const taskSummary = (id: string) => ({
  id,
  task_path: `/tasks/${id}`,
  folder_path: id.split("/")[0],
  display_name: id,
  adapter_name: "chatAdapter",
  has_checks: true,
  tags: [],
  run_stats: null,
});

const stubFetch = (summary: unknown) => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = summary !== null && url.includes("/agent-tasks?") ? [summary] : [];
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const requestedUrls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.map((call) => String(call[0]));

describe("TaskDetailPage run-history fetch", () => {
  beforeEach(() => {
    listTaskRunsMock.mockClear();
    stubFetch(null);
  });

  it("issues exactly one bounded listTaskRuns call", async () => {
    await TaskDetailPage({
      params: Promise.resolve({ projectId: "p", taskId: ["t"] }),
      searchParams: Promise.resolve({}),
    });

    expect(listTaskRunsMock).toHaveBeenCalledTimes(1);
    const [, , , limit] = listTaskRunsMock.mock.calls[0];
    expect(limit).toBe(200);
  });

  it("keeps the single bounded call when a scope is active", async () => {
    await TaskDetailPage({
      params: Promise.resolve({ projectId: "p", taskId: ["t"] }),
      searchParams: Promise.resolve({ model: "claude-opus-5" }),
    });

    expect(listTaskRunsMock).toHaveBeenCalledTimes(1);
    const [, , cohort, limit] = listTaskRunsMock.mock.calls[0];
    expect(String(cohort?.model)).toContain("claude-opus-5");
    expect(limit).toBe(200);
  });

  it("forwards the environment and label scope to the list call", async () => {
    await TaskDetailPage({
      params: Promise.resolve({ projectId: "p", taskId: ["t"] }),
      searchParams: Promise.resolve({ environment: "prod", label: ["customer:c-1", "agent:a-1"] }),
    });

    const [, , cohort] = listTaskRunsMock.mock.calls[0];
    expect(cohort).toMatchObject({ environment: ["prod"], label: ["customer:c-1", "agent:a-1"] });
  });
});

describe("TaskDetailPage task resolution", () => {
  it("resolves the body's task with one exact-ids request, never grep", async () => {
    const fetchMock = stubFetch(taskSummary("a/b"));

    await TaskDetailPage({
      params: Promise.resolve({ projectId: "p", taskId: ["a", "b"] }),
      searchParams: Promise.resolve({}),
    });

    const urls = requestedUrls(fetchMock);
    const taskLookups = urls.filter((url) => url.includes("/agent-tasks?"));
    expect(taskLookups).toHaveLength(1);
    expect(taskLookups[0]).toContain("ids=a%2Fb");
    expect(urls.some((url) => url.includes("grep="))).toBe(false);
  });

  it("generateMetadata resolves through the same exact-ids request", async () => {
    const fetchMock = stubFetch(taskSummary("a/b"));

    const metadata = await generateMetadata({
      params: Promise.resolve({ projectId: "p", taskId: ["a", "b"] }),
    });

    expect(metadata.title).toBe("a/b · Task");
    const urls = requestedUrls(fetchMock);
    const taskLookups = urls.filter((url) => url.includes("/agent-tasks?"));
    expect(taskLookups).toHaveLength(1);
    expect(taskLookups[0]).toContain("ids=a%2Fb");
    expect(urls.some((url) => url.includes("grep="))).toBe(false);
  });
});
