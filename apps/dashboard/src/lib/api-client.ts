/**
 * Deep API client seam for the backend.
 *
 * Owns the four concerns every endpoint otherwise re-implements: URL
 * composition (base + path + query), JSON body serialization, the
 * `!ok → ApiError` failure mode, and response parsing. The low-level
 * cookie/proxy mechanics stay in {@link backendFetch}; this layer sits
 * above it and gives every call a typed result and a typed error.
 *
 * Why this exists: the `*-api.ts` modules previously each hand-rolled
 * `API_BASE`, `parseDetail`, `URLSearchParams`, and `if (!res.ok) throw`.
 * {@link ApiError} was built for status-branching but adopted by one
 * caller — because there was no shared place that threw it. This is that
 * place: every `apiClient` failure is an `ApiError`, so callers can branch
 * with `isForbidden` / `isNotFoundStatus` / `isUnauthorized` instead of
 * `message.includes("403")`.
 */
import { ApiError } from "./api-error";
import { backendFetch } from "./backend-fetch";
import { getBrowserBackendBaseUrl } from "./config";

export interface RequestOptions {
  method?: string;
  /**
   * Query params; null/undefined/"" entries are skipped. A `string[]` value
   * becomes repeated keys (`?k=a&k=b`) — the backend's repeatable-filter
   * vocabulary, never a comma-joined single value.
   */
  query?: Record<string, string | number | boolean | string[] | null | undefined>;
  /** JSON-serialized and sent with `Content-Type: application/json`. */
  body?: unknown;
  cache?: RequestCache;
  signal?: AbortSignal;
  headers?: HeadersInit;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = `${getBrowserBackendBaseUrl()}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseErrorDetail(res: Response): Promise<string> {
  let body: unknown;
  let rawText = "";

  if (typeof res.text === "function") {
    rawText = await res.text().catch(() => "");
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        // Plain-text proxy/upstream failure; handled below.
      }
    }
  } else if (typeof res.json === "function") {
    body = await res.json().catch(() => undefined);
  }

  if (body && typeof body === "object") {
    const errorBody = body as Record<string, unknown>;
    for (const key of ["detail", "message", "error"]) {
      const value = errorBody[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }

  if (rawText.trim()) return rawText.trim();
  const statusText = res.statusText?.trim();
  return statusText
    ? `Request failed (${res.status} ${statusText})`
    : `Request failed (${res.status})`;
}

function buildInit(opts: RequestOptions): RequestInit {
  const headers = new Headers(opts.headers);
  const init: RequestInit = {};
  if (opts.method) init.method = opts.method;
  if (opts.cache) init.cache = opts.cache;
  if (opts.signal) init.signal = opts.signal;
  if (opts.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(opts.body);
  }
  init.headers = headers;
  return init;
}

export async function apiClient<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await backendFetch(buildUrl(path, opts.query), buildInit(opts));
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorDetail(res));
  }
  // Empty responses (204 / no content) — return undefined for `void` callers.
  if (
    res.status === 204 ||
    res.headers?.get("content-length") === "0"
  ) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

/**
 * Raw-response variant of {@link apiClient} for endpoints that return a
 * file rather than JSON: same URL/body/ApiError handling, but the caller
 * gets the `Response` itself (blob(), headers) instead of parsed JSON.
 */
export async function apiClientRaw(
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const res = await backendFetch(buildUrl(path, opts.query), buildInit(opts));
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorDetail(res));
  }
  return res;
}
