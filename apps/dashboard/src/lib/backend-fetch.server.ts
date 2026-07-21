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
 * Rewrites a backend URL to the container-reachable backend origin.
 *
 * `apiClient` builds URLs with `getBrowserBackendBaseUrl()`, which
 * returns `/backend-proxy` (relative) when no `NEXT_PUBLIC_APO_BACKEND_URL`
 * is set. Server components must not resolve that path against the public
 * request host: published ports and reverse-proxy origins are often not
 * reachable from inside the frontend container. `BACKEND_URL` is the
 * explicit internal network contract for those calls.
 */
export function toServerBackendUrl(
  input: RequestInfo | URL,
): RequestInfo | URL {
  if (typeof input !== "string" && !(input instanceof URL)) {
    return input;
  }

  const inputStr = typeof input === "string" ? input : input.toString();
  const backendBaseUrl = getServerBackendBaseUrl();

  // Relative inputs are backendFetch's normal contract. Strip the browser-only
  // proxy prefix before resolving them against the internal backend.
  if (inputStr.startsWith("/")) {
    return resolveBackendUrl(backendBaseUrl, stripProxyPrefix(inputStr));
  }

  const resolved = new URL(inputStr);
  if (hasProxyPrefix(resolved.pathname)) {
    return resolveBackendUrl(
      backendBaseUrl,
      `${stripProxyPrefix(resolved.pathname)}${resolved.search}`,
    );
  }

  if (resolved.origin !== new URL(backendBaseUrl).origin) {
    return input;
  }

  return inputStr;
}

function resolveBackendUrl(backendBaseUrl: string, path: string): string {
  const normalizedBaseUrl = backendBaseUrl.endsWith("/")
    ? backendBaseUrl
    : `${backendBaseUrl}/`;
  return new URL(path.replace(/^\//, ""), normalizedBaseUrl).toString();
}

function stripProxyPrefix(path: string): string {
  if (!hasProxyPrefix(path)) {
    return path;
  }

  return path.slice("/backend-proxy".length) || "/";
}

function hasProxyPrefix(pathname: string): boolean {
  return (
    pathname === "/backend-proxy" || pathname.startsWith("/backend-proxy/")
  );
}
