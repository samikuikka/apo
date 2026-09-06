/**
 * The public /join page renders from a valid admission preview,
 * preserves the token through the sign-in redirect for existing accounts,
 * accepts atomically, and never renders account data for dead tokens.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-auth/react", () => ({
  signIn: vi.fn().mockResolvedValue({ ok: true }),
  useSession: vi.fn().mockReturnValue({
    data: undefined,
    status: "unauthenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
  useSearchParams: vi.fn().mockReturnValue({
    get: (key: string) => (key === "token" ? "tok-123" : null),
  }),
}));

vi.mock("@/lib/hosted-access-api", () => ({
  previewHostedAccessToken: vi.fn(),
  acceptHostedAccessCreateAccount: vi.fn(),
  acceptHostedAccessExistingAccount: vi.fn(),
}));

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  previewHostedAccessToken,
  acceptHostedAccessCreateAccount,
} from "@/lib/hosted-access-api";
import JoinPage from "../page";

const validPreview = {
  valid: true,
  reason: null,
  email: "invitee@example.com",
  requires_login: false,
  requires_account_creation: true,
};

beforeEach(() => {
  vi.mocked(previewHostedAccessToken).mockReset();
  vi.mocked(acceptHostedAccessCreateAccount).mockReset();
  vi.mocked(signIn).mockClear();
});

describe("/join new-account flow", () => {
  it("renders account and Project fields from a valid preview", async () => {
    vi.mocked(previewHostedAccessToken).mockResolvedValue(validPreview);

    render(<JoinPage />);

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeDefined();
    });
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
    expect(screen.getByLabelText("Confirm password")).toBeDefined();
    expect(screen.getByLabelText("Project name")).toBeDefined();
    expect(screen.getByDisplayValue("invitee@example.com")).toBeDefined();
  });

  it("accepts, signs in, and lands on the new Project's tasks", async () => {
    vi.mocked(previewHostedAccessToken).mockResolvedValue(validPreview);
    vi.mocked(acceptHostedAccessCreateAccount).mockResolvedValue({
      status: "accepted",
      project_id: "proj-new-1",
    });

    render(<JoinPage />);
    const user = userEvent.setup();

    await waitFor(() => screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Invitee");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.type(screen.getByLabelText("Confirm password"), "hunter2hunter2");
    await user.type(screen.getByLabelText("Project name"), "Fresh Start");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(acceptHostedAccessCreateAccount).toHaveBeenCalledWith({
        token: "tok-123",
        name: "Invitee",
        password: "hunter2hunter2",
        project_name: "Fresh Start",
      });
    });
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("credentials", {
        email: "invitee@example.com",
        password: "hunter2hunter2",
        redirect: false,
        redirectTo: "/project/proj-new-1/tasks",
      });
    });
    expect(vi.mocked(useRouter).mock.results[0]?.value.push).toHaveBeenCalledWith(
      "/project/proj-new-1/tasks",
    );
  });
});

describe("/join existing-account flow", () => {
  const existingPreview = {
    valid: true,
    reason: null,
    email: "known@example.com",
    requires_login: true,
    requires_account_creation: false,
  };

  it("asks to sign in while preserving the token through the redirect", async () => {
    vi.mocked(previewHostedAccessToken).mockResolvedValue(existingPreview);

    render(<JoinPage />);

    const signInLink = await screen.findByRole("link", {
      name: /sign in to accept/i,
    });
    expect(signInLink.getAttribute("href")).toBe(
      `/login?callbackUrl=${encodeURIComponent("/join?token=tok-123")}`,
    );
  });
});

describe("/join dead-token states", () => {
  it.each(["expired", "revoked", "accepted", "invalid"] as const)(
    "renders a distinct %s state without email data",
    async (reason) => {
      vi.mocked(previewHostedAccessToken).mockResolvedValue({
        valid: false,
        reason,
        email: null,
        requires_login: false,
        requires_account_creation: false,
      });

      render(<JoinPage />);

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: /invitation/i }),
        ).toBeDefined();
      });
      expect(screen.queryByLabelText("Email")).toBeNull();
      expect(screen.queryByLabelText("Project name")).toBeNull();
    },
  );
});
