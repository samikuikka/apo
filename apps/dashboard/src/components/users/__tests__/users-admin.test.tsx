/**
 * The administrator Users page lists every account and offers lock,
 * unlock, and admin-flag actions, never a delete. The signed-in admin's
 * own row offers no actions. Non-administrators never render the table
 * (server gate).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/users-api", () => ({
  listUsers: vi.fn(),
  updateUser: vi.fn(),
  deactivateUser: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { toast } from "sonner";
import {
  deactivateUser,
  listUsers,
  updateUser,
  type UserSummary,
} from "@/lib/users-api";
import { auth } from "@/auth";
import { UsersAdmin } from "../users-admin";
import UsersSettingsPage from "@/app/settings/users/page";

const ADMIN_ID = "admin-1";

function account(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: "u-2",
    email: "member@example.com",
    name: "Grace Hopper",
    is_admin: false,
    is_active: true,
    created_at: "2026-08-15T00:00:00Z",
    ...overrides,
  };
}

const self = account({
  id: ADMIN_ID,
  email: "admin@example.com",
  name: "Ada Lovelace",
  is_admin: true,
});

function renderUsersAdmin(users: UserSummary[] | null) {
  render(<UsersAdmin initialUsers={users} currentUserId={ADMIN_ID} />);
  return userEvent.setup();
}

function selfRow() {
  return screen.getByRole("row", { name: /admin@example\.com/ });
}

beforeEach(() => {
  vi.mocked(listUsers).mockReset();
  vi.mocked(updateUser).mockReset();
  vi.mocked(deactivateUser).mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("UsersAdmin", () => {
  it("lists users from the server prefetch", () => {
    renderUsersAdmin([self, account()]);

    expect(screen.getByText("admin@example.com")).toBeDefined();
    expect(screen.getByText("member@example.com")).toBeDefined();
    expect(screen.getByText("Admin")).toBeDefined();
    expect(screen.getByText("User")).toBeDefined();
  });

  it("offers no actions on the signed-in admin's own row", () => {
    renderUsersAdmin([self, account()]);

    expect(within(selfRow()).queryAllByRole("button")).toHaveLength(0);
    expect(within(selfRow()).getByText("You")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Deactivate admin@example.com" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Deactivate member@example.com" }),
    ).toBeDefined();
  });

  it("deactivates a user only after the policy confirmation", async () => {
    vi.mocked(deactivateUser).mockResolvedValue(undefined);
    const user = renderUsersAdmin([self, account()]);

    await user.click(
      screen.getByRole("button", { name: "Deactivate member@example.com" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Deactivate user" });
    expect(within(dialog).getByText(/projects and data are kept/i)).toBeDefined();
    expect(deactivateUser).not.toHaveBeenCalled();

    await user.click(
      within(dialog).getByRole("button", { name: "Deactivate user" }),
    );

    await waitFor(() => {
      expect(deactivateUser).toHaveBeenCalledWith("u-2");
    });
    expect(
      await screen.findByRole("button", { name: "Reactivate member@example.com" }),
    ).toBeDefined();
    expect(screen.getByText("Deactivated")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("User deactivated");
  });

  it("reactivates a deactivated user", async () => {
    vi.mocked(updateUser).mockResolvedValue(account({ is_active: true }));
    const user = renderUsersAdmin([self, account({ is_active: false })]);

    // A locked account offers only the unlock, not the admin toggle.
    expect(screen.queryByRole("button", { name: /make admin/i })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Reactivate member@example.com" }),
    );

    await waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith("u-2", { is_active: true });
    });
    expect(
      await screen.findByRole("button", { name: "Deactivate member@example.com" }),
    ).toBeDefined();
    expect(toast.success).toHaveBeenCalledWith("User reactivated");
  });

  it("grants the admin role to another user", async () => {
    vi.mocked(updateUser).mockResolvedValue(account({ is_admin: true }));
    const user = renderUsersAdmin([self, account()]);

    await user.click(
      screen.getByRole("button", { name: "Make admin member@example.com" }),
    );

    await waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith("u-2", { is_admin: true });
    });
    expect(
      await screen.findByRole("button", {
        name: "Remove admin member@example.com",
      }),
    ).toBeDefined();
    expect(toast.success).toHaveBeenCalledWith("Admin role granted");
  });

  it("removes the admin role from another admin", async () => {
    vi.mocked(updateUser).mockResolvedValue(account({ is_admin: false }));
    const user = renderUsersAdmin([self, account({ is_admin: true })]);

    await user.click(
      screen.getByRole("button", { name: "Remove admin member@example.com" }),
    );

    await waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith("u-2", { is_admin: false });
    });
    expect(
      await screen.findByRole("button", { name: "Make admin member@example.com" }),
    ).toBeDefined();
    expect(toast.success).toHaveBeenCalledWith("Admin role removed");
  });

  it("reports a refused deactivation and leaves the account active", async () => {
    vi.mocked(deactivateUser).mockRejectedValue(
      new Error("Admin access required"),
    );
    const user = renderUsersAdmin([self, account()]);

    await user.click(
      screen.getByRole("button", { name: "Deactivate member@example.com" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Deactivate user" });
    await user.click(
      within(dialog).getByRole("button", { name: "Deactivate user" }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Admin access required");
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByText("Deactivated")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Deactivate member@example.com" }),
    ).toBeEnabled();
  });

  it("loads users on mount when the server prefetch failed", async () => {
    vi.mocked(listUsers).mockResolvedValue([self, account()]);
    renderUsersAdmin(null);

    expect(screen.getByText("Loading users…")).toBeDefined();
    expect(await screen.findByText("member@example.com")).toBeDefined();
  });

  it("shows the load failure when the fallback fetch fails", async () => {
    vi.mocked(listUsers).mockRejectedValue(new Error("Backend unreachable"));
    renderUsersAdmin(null);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Backend unreachable",
    );
  });
});

describe("UsersSettingsPage admin gate", () => {
  it("renders the users table for an installation admin", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: ADMIN_ID, email: "admin@example.com", is_admin: true },
    } as unknown as Awaited<ReturnType<typeof auth>>);
    vi.mocked(listUsers).mockResolvedValue([self, account()]);

    const ui = await UsersSettingsPage();
    render(ui);

    expect(
      screen.getByRole("button", { name: "Deactivate member@example.com" }),
    ).toBeDefined();
    // The session's user id reaches the table, so the admin's own row is inert.
    expect(within(selfRow()).queryAllByRole("button")).toHaveLength(0);
  });

  it("renders only the access-required notice for non-admins", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "u-2", email: "member@example.com", is_admin: false },
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const ui = await UsersSettingsPage();
    render(ui);

    expect(screen.getByText(/administrator access required/i)).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
    expect(listUsers).not.toHaveBeenCalled();
  });
});
