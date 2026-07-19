import { apiClient } from "./api-client";

export const signOutEverywhere = (): Promise<void> =>
  apiClient("/auth/sign-out-everywhere", { method: "POST" });
