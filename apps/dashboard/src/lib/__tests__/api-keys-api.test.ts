/**
 * the dashboard API helper defaults to the
 * least-privileged ``ingest`` scope. The previous default of ``full`` made
 * every dashboard-minted key a management credential, which is unsafe for
 * the common telemetry-producer issuance flow.
 *
 * Issue #72: the backend serializes API-key responses in snake_case
 * (``public_key``, ``secret_key``, ``display_secret_key``). The dashboard
 * boundary must normalize them to camelCase so the reveal dialog and list
 * rows receive real values instead of ``undefined``.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config", () => ({
  getBrowserBackendBaseUrl: () => "http://localhost:8000",
}));

vi.mock("../backend-fetch", () => ({
  backendFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

import {
  createApiKey,
  listApiKeys,
  rotateApiKey,
} from "../api-keys-api";
import { ApiError } from "../api-error";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Realistic backend fixtures — exactly what FastAPI/SQLModel serializes today
// (snake_case key fields). These MUST drive the dashboard adapters; camelCase
// fixtures would hide the casing bug (issue #72).
const snakeCaseCreateResponse = {
  id: "k1",
  name: "Production",
  prefix: "pk-apo-",
  project: "example-service",
  created_by: "u1",
  scope: "ingest",
  created_at: "2026-07-30T00:00:00",
  last_used_at: null,
  expires_at: null,
  public_key: "pk-apo-abc123",
  secret_key: "sk-apo-secret456",
  display_secret_key: "sk-apo-se••••",
};

const snakeCaseListResponse = [
  {
    id: "k1",
    name: "Production",
    prefix: "pk-apo-",
    project: "example-service",
    created_by: "u1",
    scope: "ingest",
    created_at: "2026-07-30T00:00:00",
    last_used_at: null,
    expires_at: null,
    public_key: "pk-apo-abc123",
    display_secret_key: "sk-apo-se••••",
  },
];

const snakeCaseRotateResponse = {
  id: "k1",
  public_key: "pk-apo-newpub",
  secret_key: "sk-apo-newsecret",
  message: "Key rotated successfully. The old key is no longer valid.",
};

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        id: "k1",
        name: "n",
        prefix: "p",
        project: "proj",
        created_by: "u",
        scope: "ingest",
        created_at: "now",
        last_used_at: null,
        expires_at: null,
      }),
  });
});

describe("createApiKey default scope", () => {
  it("defaults to ingest when scope is omitted", async () => {
    await createApiKey("Production", "example-service");
    const [, init] = mockFetch.mock.calls[0];
    expect(init?.body).toEqual(
      JSON.stringify({
        name: "Production",
        project: "example-service",
        scope: "ingest",
        expires_at: null,
        daily_span_quota: null,
      }),
    );
  });

  it("still passes an explicit full scope through", async () => {
    await createApiKey("CLI", "example-service", "full");
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(init?.body)).scope).toBe("full");
  });
});

describe("createApiKey response normalization (issue #72)", () => {
  it("maps snake_case key fields to camelCase so the reveal dialog gets values", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(snakeCaseCreateResponse),
    });

    const result = await createApiKey("Production", "example-service", "ingest");

    expect(result.publicKey).toBe("pk-apo-abc123");
    expect(result.secretKey).toBe("sk-apo-secret456");
    expect(result.displaySecretKey).toBe("sk-apo-se••••");
  });

  it("preserves the legacy single-key `key` field for bootstrap-created keys", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...snakeCaseCreateResponse,
          public_key: null,
          secret_key: null,
          display_secret_key: null,
          key: "sk-legacy-key",
        }),
    });

    const result = await createApiKey("CLI", "example-service", "full");

    expect(result.key).toBe("sk-legacy-key");
    expect(result.publicKey).toBeNull();
    expect(result.secretKey).toBeNull();
  });
});

describe("rotateApiKey response normalization (issue #72)", () => {
  it("maps snake_case key fields to camelCase so rotation reveals the new pair", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(snakeCaseRotateResponse),
    });

    const result = await rotateApiKey("k1");

    expect(result.publicKey).toBe("pk-apo-newpub");
    expect(result.secretKey).toBe("sk-apo-newsecret");
    expect(result.id).toBe("k1");
  });
});

describe("listApiKeys response normalization (issue #72)", () => {
  it("maps snake_case public_key/display_secret_key to camelCase for list rows", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(snakeCaseListResponse),
    });

    const result = await listApiKeys("example-service");

    expect(result).toHaveLength(1);
    expect(result[0].publicKey).toBe("pk-apo-abc123");
    expect(result[0].displaySecretKey).toBe("sk-apo-se••••");
  });

  it("never exposes the full secret in list responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(snakeCaseListResponse),
    });

    const result = await listApiKeys("example-service");

    // The normalized row must not carry the secret in either casing.
    const leaked = result[0] as unknown as Record<string, unknown>;
    expect(leaked).not.toHaveProperty("secret_key");
    expect(leaked).not.toHaveProperty("secretKey");
  });
});

describe("API error path (issue #72)", () => {
  it("throws an ApiError carrying the status when creation fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      json: () => Promise.resolve({ detail: "Expiry must be in the future" }),
      text: () => Promise.resolve('{"detail":"Expiry must be in the future"}'),
    });

    await expect(createApiKey("Bad", "example-service")).rejects.toSatisfy(
      (err: unknown) => err instanceof ApiError && err.status === 422,
    );
  });
});
