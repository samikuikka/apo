import type { Config } from "./config.ts";
import { readCredentials } from "./credentials.ts";

export type ApiError = {
  status: number;
  message: string;
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DELETE_TIMEOUT_MS = 60_000;

function authHeaders(config?: Config): Record<string, string> {
  const apiKey = config?.apiKey ?? process.env.APO_API_KEY;
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

type RequestOptions = {
  params?: Record<string, string | string[]>;
  body?: unknown;
  config?: Config;
  /** Override the 15s default; deletes of large batches cascade through
   * many rows and stored objects and can legitimately run longer. */
  timeoutMs?: number;
};

/**
 * Single JSON request path shared by every method wrapper: URL + query
 * building, auth headers, timeout, and the uniform error contract
 * (AuthError on 401, "Backend error <status>" on other HTTP failures,
 * "Cannot connect" on network failure).
 */
async function apiRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = resolveApiUrl(baseUrl, path);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (v !== undefined && v !== "") {
          url.searchParams.append(key, v);
        }
      }
    }
  }

  const hasBody = method !== "GET" && method !== "DELETE";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: hasBody
        ? { "Content-Type": "application/json", ...authHeaders(options.config) }
        : authHeaders(options.config),
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Request timed out after ${timeoutMs / 1000}s — is the backend running at ${baseUrl}?`,
      );
    }
    throw new Error(`Cannot connect to backend at ${baseUrl}`);
  }

  if (response.status === 401) {
    throw new AuthError(authRequiredMessage());
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Backend error ${response.status}: ${body}`);
  }

  return (await response.json()) as T;
}

export function apiGet<T>(
  baseUrl: string,
  path: string,
  params?: Record<string, string | string[]>,
  config?: Config,
  timeoutMs?: number,
): Promise<T> {
  return apiRequest<T>("GET", baseUrl, path, { params, config, timeoutMs });
}

export function apiPost<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  config?: Config,
): Promise<T> {
  return apiRequest<T>("POST", baseUrl, path, { body, config });
}

export function apiPut<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  config?: Config,
): Promise<T> {
  return apiRequest<T>("PUT", baseUrl, path, { body, config });
}

export function apiPatch<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  config?: Config,
): Promise<T> {
  return apiRequest<T>("PATCH", baseUrl, path, { body, config });
}

export function apiDelete<T>(
  baseUrl: string,
  path: string,
  config?: Config,
): Promise<T> {
  return apiRequest<T>("DELETE", baseUrl, path, {
    config,
    timeoutMs: DELETE_TIMEOUT_MS,
  });
}

/**
 * Verify a stored API key still works against a backend WITHOUT going through
 * the uniform error contract: callers need the tri-state (valid / invalid /
 * unreachable) to decide between switching, re-authenticating, and refusing.
 *
 * Probes /v1/api-keys, NOT /v1/projects: the projects list is open to
 * anonymous callers (demo project), so a 200 there proves nothing about the
 * key — a bad key would sail through verification.
 */
export async function checkSavedKey(
  backendUrl: string,
  apiKey: string,
): Promise<"valid" | "invalid" | "unknown"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = resolveApiUrl(backendUrl, "/v1/api-keys");
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (res.ok) return "valid";
    if (res.status === 401) return "invalid";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

export async function isBackendReachable(baseUrl: string): Promise<boolean> {
  try {
    const url = resolveApiUrl(baseUrl, "/health");
    // This is the first call most commands make — a stalled backend must
    // resolve to "unreachable" quickly, not hang the command on undici's
    // ~300s default.
    await fetch(url.toString(), { method: "GET", signal: AbortSignal.timeout(5_000) });
    // Any HTTP response means the server is up. A 401/403 just means auth
    // is enforced — the caller has credentials and will authenticate on
    // the actual API call. Only a network failure (catch) means unreachable.
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a streaming response with a longer timeout.
 *
 * Artifact downloads can be large and slow; the default 15s request timeout
 * is too short. Returns the raw Response so the caller can stream the body.
 */
export async function apiStream(
  baseUrl: string,
  path: string,
  config?: Config,
  timeoutMs = 120_000,
): Promise<Response> {
  const url = resolveApiUrl(baseUrl, path);
  try {
    const response = await fetch(url.toString(), {
      headers: authHeaders(config),
      signal: timeoutSignal(timeoutMs),
    });
    if (response.status === 401) {
      throw new AuthError(authRequiredMessage());
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Backend error ${response.status}: ${body}`);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Request timed out after ${timeoutMs / 1000}s — is the backend running at ${baseUrl}?`,
      );
    }
    throw error;
  }
}

function resolveApiUrl(baseUrl: string, path: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const relativePath = path.replace(/^\/+/, "");
  return new URL(relativePath, normalizedBaseUrl);
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function authRequiredMessage(): string {
  // The most common cause of a 401 with saved credentials is switching
  // backends (e.g. `pnpm dev` <-> docker): the key is valid for one database
  // but not the other. Point the user at `--force` in that case.
  const hasCreds = readCredentials() != null;
  const hint = hasCreds
    ? `Your API key was rejected. If you switched backends, run \`${bold("apo login --force")}\` to re-authenticate.`
    : `Run \`${bold("apo login")}\` first, or set the APO_API_KEY env var.`;
  return `Authentication required. ${hint}`;
}
