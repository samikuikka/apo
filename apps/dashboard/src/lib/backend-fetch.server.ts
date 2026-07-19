/**
 * Server-only backend fetch helpers.
 *
 * Split from `backend-fetch.ts` so that `process.env.BACKEND_URL` and
 * the `next/headers` imports are never pulled into client bundles by
 * the Turbopack module graph. Client code imports `backendFetch` from
 * `backend-fetch.ts`, which dynamically imports this module only when
 * running on the server.
 */
import { getServerBackendBaseUrl } from "./config.server";

/**
 * Reads the cookie header from the Next.js request context so the
 * server-side fetch forwards the user's session to the backend.
 */
export async function getServerCookieHeader(): Promise<string | null> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();

  if (allCookies.length === 0) {
    return null;
  }

  return allCookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/**
 * Rewrites a backend-origin URL to the same-origin `/backend-proxy`
 * path so server-side fetches go through Next's route handler (which
 * forwards to the real backend with the correct origin).
 *
 * `apiClient` builds URLs with `getBrowserBackendBaseUrl()`, which
 * returns `/backend-proxy` (relative) when no `NEXT_PUBLIC_APO_BACKEND_URL`
 * is set. On the server, `fetch()` needs an absolute URL, so relative
 * paths are resolved against the server request origin. Full backend
 * URLs (e.g. `http://localhost:8000/v1/...`) are rewritten to the
 * same-origin proxy path.
 */
export async function toServerProxyUrl(
  input: RequestInfo | URL,
): Promise<RequestInfo | URL> {
  if (typeof input !== "string" && !(input instanceof URL)) {
    return input;
  }

  const inputStr = typeof input === "string" ? input : input.toString();
  const serverOrigin = await getServerRequestOrigin();

  // Already a relative proxy path — resolve to an absolute same-origin
  // URL so server-side `fetch()` can parse it.
  if (inputStr.startsWith("/")) {
    return `${serverOrigin}${inputStr}`;
  }

  const backendBaseUrl = getServerBackendBaseUrl();
  const backendOrigin = new URL(backendBaseUrl).origin;
  const resolved = new URL(inputStr, serverOrigin);

  if (resolved.origin !== backendOrigin) {
    return input;
  }

  return `${serverOrigin}/backend-proxy${resolved.pathname}${resolved.search}`;
}

async function getServerRequestOrigin(): Promise<string> {
  const { headers } = await import("next/headers");
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "http";

  if (host) {
    return `${proto}://${host}`;
  }

  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}
