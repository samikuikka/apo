import { apiClient } from "./api-client";

export type ApiKeyScope = "full" | "ingest";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  project: string;
  created_by: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  /** Public key (pk-apo-xxx) — always visible */
  publicKey?: string | null;
  /** Masked secret for display (e.g. sk-apo-abcd...wxyz) */
  displaySecretKey?: string | null;
}

export interface ApiKeyCreateResponse {
  id: string;
  name: string;
  prefix: string;
  project: string;
  /** Legacy single key (sk-xxx). Null for two-key model keys. */
  key?: string | null;
  /** Public key (pk-apo-xxx) */
  publicKey?: string | null;
  /** Secret key (sk-apo-xxx) — shown once at creation, never again */
  secretKey?: string | null;
  /** Masked secret for display */
  displaySecretKey?: string | null;
  created_by: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface ApiKeyRotateResponse {
  id: string;
  /** Legacy single key. Null for two-key model keys. */
  key?: string | null;
  /** Public key (pk-apo-xxx) */
  publicKey?: string | null;
  /** Secret key (sk-apo-xxx) — shown once at rotation */
  secretKey?: string | null;
  message: string;
}

export const createApiKey = (
  name: string,
  project: string,
  scope: ApiKeyScope = "full",
  expiresAt?: string,
): Promise<ApiKeyCreateResponse> =>
  apiClient("/v1/api-keys", {
    method: "POST",
    body: { name, project, scope, expires_at: expiresAt ?? null },
  });

export const listApiKeys = (project?: string): Promise<ApiKey[]> =>
  apiClient("/v1/api-keys", {
    cache: "no-store",
    query: project ? { project } : undefined,
  });

export const revokeApiKey = (id: string): Promise<void> =>
  apiClient(`/v1/api-keys/${id}`, { method: "DELETE" });

export const rotateApiKey = (id: string): Promise<ApiKeyRotateResponse> =>
  apiClient(`/v1/api-keys/${id}/rotate`, { method: "POST" });
