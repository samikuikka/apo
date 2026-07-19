import { getBrowserBackendBaseUrl } from "./config";

/**
 * Universal fetch wrapper that forwards cookies and rewrites URLs to
 * the same-origin `/backend-proxy` path.
 *
 * On the server, dynamically imports `backend-fetch.server.ts` (which
 * reads `next/headers` and `process.env.BACKEND_URL`) so those
 * server-only references never enter the client bundle. On the browser,
 * rewrites URLs directly to the relative proxy path.
 */
export async function backendFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  let target: RequestInfo | URL = input;

  if (typeof window === "undefined") {
    const { getServerCookieHeader, toServerProxyUrl } = await import(
      "./backend-fetch.server"
    );
    const cookieHeader = await getServerCookieHeader();
    if (cookieHeader && !headers.has("cookie")) {
      headers.set("cookie", cookieHeader);
    }
    target = await toServerProxyUrl(input);
  } else {
    target = toBrowserProxyUrl(input);
  }

  return fetch(target, {
    ...init,
    headers,
    credentials: init.credentials ?? "include",
  });
}

/**
 * Rewrites a backend-origin URL to the relative `/backend-proxy` path
 * for browser-side fetches. Keeps the browser on the public origin.
 */
export function toBrowserProxyUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input !== "string" && !(input instanceof URL)) {
    return input;
  }

  const inputStr = typeof input === "string" ? input : input.toString();
  const resolved = new URL(inputStr, window.location.origin);

  // Relative paths are already same-origin — send them through as-is.
  // This covers the common backendFetch("/v1/...") case.
  if (inputStr.startsWith("/")) {
    return input;
  }

  const backendBaseUrl = getBrowserBackendBaseUrl();
  // If the browser helper fell back to the relative proxy, rewrite
  // any backend-origin URL to the relative proxy path.
  if (backendBaseUrl.startsWith("/")) {
    return `/backend-proxy${resolved.pathname}${resolved.search}`;
  }

  const backendOrigin = new URL(backendBaseUrl).origin;
  if (resolved.origin !== backendOrigin) {
    return input;
  }

  return `/backend-proxy${resolved.pathname}${resolved.search}`;
}
