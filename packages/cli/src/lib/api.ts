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

function authHeaders(config?: Config): Record<string, string> {
  const apiKey =
    config?.apiKey ?? process.env.APO_API_KEY ?? process.env.APO_API_KEY;
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export async function apiGet<T>(
  baseUrl: string,
  path: string,
  params?: Record<string, string>,
  config?: Config,
): Promise<T> {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: authHeaders(config),
      signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s — is the backend running at ${baseUrl}?`);
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

export async function apiPost<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  config?: Config,
): Promise<T> {
  const url = new URL(path, baseUrl);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(config) },
      body: JSON.stringify(body),
      signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s — is the backend running at ${baseUrl}?`);
    }
    throw new Error(`Cannot connect to backend at ${baseUrl}`);
  }

  if (response.status === 401) {
    throw new AuthError(authRequiredMessage());
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend error ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}

export async function apiPatch<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  config?: Config,
): Promise<T> {
  const url = new URL(path, baseUrl);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(config) },
      body: JSON.stringify(body),
      signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s — is the backend running at ${baseUrl}?`);
    }
    throw new Error(`Cannot connect to backend at ${baseUrl}`);
  }

  if (response.status === 401) {
    throw new AuthError(authRequiredMessage());
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend error ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}

export async function isBackendReachable(baseUrl: string): Promise<boolean> {
  try {
    const url = new URL("/health", baseUrl);
    const response = await fetch(url.toString(), { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
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
