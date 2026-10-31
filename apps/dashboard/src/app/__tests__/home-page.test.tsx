/**
 * The authenticated home page must tell a fetch failure apart from a
 * genuinely empty account: a dead backend, a wrong port, or an expired
 * session renders an explicit error state, never the "create your first
 * project" prompt. A stalled evaluator looking at a near-blank dashboard
 * with a misleading call to action is the exact failure mode these tests
 * guard against.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: vi.fn().mockReturnValue({
    data: undefined,
    status: "unauthenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}));

vi.mock("@/lib/projects-api", () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
}));

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { listProjects, type Project } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-error";
import Home from "../page";

const session = { user: { email: "user@example.com" } } as unknown as Awaited<
  ReturnType<typeof auth>
>;

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue(session);
  vi.mocked(redirect).mockReset();
  vi.mocked(listProjects).mockReset();
});

describe("authenticated home page data states", () => {
  it("renders the create-project empty state when the account has zero projects", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);

    render(await Home());

    expect(screen.getByText("Create your first project")).toBeDefined();
    expect(
      screen.queryByText(/could not load your projects/i),
    ).toBeNull();
  });

  it("renders an error state, not the empty state, when the fetch rejects with a network error", async () => {
    vi.mocked(listProjects).mockRejectedValue(new TypeError("fetch failed"));

    render(await Home());

    expect(screen.queryByText("Create your first project")).toBeNull();
    expect(screen.getByText(/could not load your projects/i)).toBeDefined();
  });

  it("renders an error state, not the empty state, when the backend rejects with 401", async () => {
    vi.mocked(listProjects).mockRejectedValue(
      new ApiError(401, "Not authenticated"),
    );

    render(await Home());

    expect(screen.queryByText("Create your first project")).toBeNull();
    expect(screen.getByText(/could not load your projects/i)).toBeDefined();
  });

  it("redirects to the first owned project, skipping the demo workspace", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      { id: "demo" },
      { id: "proj-1" },
    ] as Project[]);

    await Home();

    expect(redirect).toHaveBeenCalledWith("/project/proj-1/tasks");
  });
});
