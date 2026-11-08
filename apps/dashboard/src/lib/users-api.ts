import { apiClient } from "./api-client";

/** One account on this apo installation, as the admin user list returns it. */
export interface UserSummary {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
}

export interface UserPatch {
  is_admin?: boolean;
  is_active?: boolean;
  name?: string;
}

export const signOutEverywhere = (): Promise<void> =>
  apiClient("/auth/sign-out-everywhere", { method: "POST" });

/** Every account on the installation, oldest first. Admin only. */
export async function listUsers(): Promise<UserSummary[]> {
  const response = await apiClient<{ users: UserSummary[] }>("/auth/users", {
    cache: "no-store",
  });
  return response.users;
}

/** Change an account's admin flag, active flag, or name. Admin only. */
export const updateUser = (
  userId: string,
  patch: UserPatch,
): Promise<UserSummary> =>
  apiClient(`/auth/users/${userId}`, { method: "PATCH", body: patch });

/**
 * Lock an account out: its sessions end and its API keys stop working.
 * The account and everything it owns are kept. Admin only.
 */
export async function deactivateUser(userId: string): Promise<void> {
  await apiClient(`/auth/users/${userId}`, { method: "DELETE" });
}
