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
  /** Accepted spans/day this key may ingest; null = unlimited (per key). */
  dailySpanQuota?: number | null;
  ingestPaused?: boolean;
  todayUsage?: { day: string; spans: number; bytes: number } | null;
}

export interface ApiKeyCreateResponse {
  id: string;
  name: string;
  prefix: string;
  project: string;
  /** Accepted spans/day for this key; null = unlimited. */
  dailySpanQuota?: number | null;
  ingestPaused?: boolean;
  todayUsage?: { day: string; spans: number; bytes: number } | null;
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

/**
 * Raw shape FastAPI/SQLModel serializes over the wire (snake_case).
 *
 * The dashboard types below read these as camelCase, so the boundary must
 * normalize explicitly — see {@link adaptCreateResponse} et al. Defining the
 * raw contract here keeps the adapter honest: a field the backend adds shows
 * up as a typecheck rather than silently becoming ``undefined`` on the client.
 */
interface RawApiKey {
  id: string;
  name: string;
  prefix: string;
  project: string;
  created_by: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  public_key?: string | null;
  secret_key?: string | null;
  display_secret_key?: string | null;
  daily_span_quota?: number | null;
  ingest_paused?: boolean;
  today_usage?: { day: string; spans: number; bytes: number } | null;
}

interface RawApiKeyCreateResponse extends RawApiKey {
  /** Legacy single key (sk-xxx). Absent for two-key model keys. */
  key?: string | null;
}

interface RawApiKeyRotateResponse {
  id: string;
  key?: string | null;
  public_key?: string | null;
  secret_key?: string | null;
  message: string;
}

/** Normalize a two-key field (snake → camel), defaulting missing to ``null``. */
function adaptCreateResponse(
  raw: RawApiKeyCreateResponse,
): ApiKeyCreateResponse {
  return {
    id: raw.id,
    name: raw.name,
    prefix: raw.prefix,
    project: raw.project,
    created_by: raw.created_by,
    scope: raw.scope,
    created_at: raw.created_at,
    last_used_at: raw.last_used_at,
    expires_at: raw.expires_at,
    key: raw.key ?? null,
    publicKey: raw.public_key ?? null,
    secretKey: raw.secret_key ?? null,
    displaySecretKey: raw.display_secret_key ?? null,
    dailySpanQuota: raw.daily_span_quota ?? null,
    ingestPaused: raw.ingest_paused ?? false,
    todayUsage: raw.today_usage ?? null,
  };
}

/** Normalize a list row. List responses never carry the secret key. */
function adaptApiKey(raw: RawApiKey): ApiKey {
  return {
    id: raw.id,
    name: raw.name,
    prefix: raw.prefix,
    project: raw.project,
    created_by: raw.created_by,
    scope: raw.scope,
    created_at: raw.created_at,
    last_used_at: raw.last_used_at,
    expires_at: raw.expires_at,
    publicKey: raw.public_key ?? null,
    displaySecretKey: raw.display_secret_key ?? null,
    dailySpanQuota: raw.daily_span_quota ?? null,
    ingestPaused: raw.ingest_paused ?? false,
    todayUsage: raw.today_usage ?? null,
  };
}

/** Normalize a rotation response (snake → camel), preserving the legacy key. */
function adaptRotateResponse(
  raw: RawApiKeyRotateResponse,
): ApiKeyRotateResponse {
  return {
    id: raw.id,
    key: raw.key ?? null,
    publicKey: raw.public_key ?? null,
    secretKey: raw.secret_key ?? null,
    message: raw.message,
  };
}

/**
 * Create a new API key pair.
 *
 * defaults to ``ingest`` (least privilege) — the common
 * telemetry-producer use case. Pass ``"full"`` explicitly for CLI and
 * management credentials.
 */
export const createApiKey = (
  name: string,
  project: string,
  scope: ApiKeyScope = "ingest",
  expiresAt?: string,
  dailySpanQuota?: number | null,
): Promise<ApiKeyCreateResponse> =>
  apiClient<RawApiKeyCreateResponse>("/v1/api-keys", {
    method: "POST",
    body: {
      name,
      project,
      scope,
      expires_at: expiresAt ?? null,
      daily_span_quota: dailySpanQuota ?? null,
    },
  }).then(adaptCreateResponse);

export const listApiKeys = (project?: string): Promise<ApiKey[]> =>
  apiClient<RawApiKey[]>("/v1/api-keys", {
    cache: "no-store",
    query: project ? { project } : undefined,
  }).then((rows) => rows.map(adaptApiKey));

export const revokeApiKey = (id: string): Promise<void> =>
  apiClient(`/v1/api-keys/${id}`, { method: "DELETE" });

export const rotateApiKey = (id: string): Promise<ApiKeyRotateResponse> =>
  apiClient<RawApiKeyRotateResponse>(
    `/v1/api-keys/${id}/rotate`,
    { method: "POST" },
  ).then(adaptRotateResponse);


/** Ingest guardrail edits. Pass null/0 to clear the quota. */
export async function patchApiKey(
  keyId: string,
  patch: { dailySpanQuota?: number | null; ingestPaused?: boolean },
): Promise<ApiKey> {
  return apiClient<RawApiKey>(`/v1/api-keys/${keyId}`, {
    method: "PATCH",
    body: {
      daily_span_quota: patch.dailySpanQuota ?? undefined,
      ingest_paused: patch.ingestPaused,
    },
  }).then(adaptApiKey);
}

export interface ApiKeyUsageDay {
  day: string;
  span_count: number;
  byte_count: number;
  request_count: number;
}

export interface ApiKeyUsage {
  key_id: string;
  name: string;
  project: string;
  daily_span_quota: number | null;
  ingest_paused: boolean;
  usage: ApiKeyUsageDay[];
}

/** Per-key daily ingest usage rows (admin). */
export async function fetchApiKeyUsage(
  project: string,
  days = 14,
): Promise<ApiKeyUsage[]> {
  const data = await apiClient<{ keys: ApiKeyUsage[] }>(
    `/v1/api-keys/usage`,
    { query: { project, days } },
  );
  return data.keys ?? [];
}