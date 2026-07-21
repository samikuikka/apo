import { getBrowserBackendBaseUrl } from "./config";

/**
 * Universal fetch wrapper that forwards cookies and routes backend URLs
 * through the correct network path for the current runtime.
 *
 * On the server, dynamically imports `backend-fetch.server.ts` (which
 * reads `next/headers` and `process.env.BACKEND_URL`) so those
 * server-only references never enter the client bundle. Server calls go
 * directly to the internal backend; browser calls use the relative proxy.
 */
export async function backendFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  let target: RequestInfo | URL = input;

  if (typeof window === "undefined") {
    const { getServerCookieHeader, toServerBackendUrl } = await import(
      "./backend-fetch.server"
    );
    const cookieHeader = await getServerCookieHeader();
    if (cookieHeader && !headers.has("cookie")) {
      headers.set("cookie", cookieHeader);
    }
    target = toServerBackendUrl(input);
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
 * Path prefixes that belong to the backend, not the Next.js server.
 *
 * Browser code calls e.g. `backendFetch("/auth/setup")` or
 * `apiClient("/v1/projects")` with bare paths. These routes do NOT exist on
 * the Next.js server — they live on the backend and are only reachable
 * through the same-origin `/backend-proxy` rewrite. Without rewriting,
 * the browser POSTs to `/auth/setup` literally and Next.js returns a 404
 * HTML page, which surfaces as a generic "Failed to create account" style
 * error (the JSON detail is missing from the HTML body).
 *
 * `/api/auth/*` is intentionally NOT here — that is NextAuth's own route
 * handler on the Next.js server, not a backend route.
 */
const BACKEND_PATH_PREFIXES = ["/v1/", "/auth/", "/public/", "/health/"];

function isBackendPath(pathname: string): boolean {
  return BACKEND_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
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

  // Absolute backend-origin URL (e.g. http://localhost:8000/v1/...).
  // Rewrite it to the relative proxy path so the browser stays same-origin.
  if (resolved.origin !== window.location.origin) {
    const backendBaseUrl = getBrowserBackendBaseUrl();
    if (backendBaseUrl.startsWith("/")) {
      return `/backend-proxy${resolved.pathname}${resolved.search}`;
    }
    const backendOrigin = new URL(backendBaseUrl).origin;
    if (resolved.origin === backendOrigin) {
      return `/backend-proxy${resolved.pathname}${resolved.search}`;
    }
    // Different origin entirely — not a backend URL, leave untouched.
    return input;
  }

  // Same-origin relative path. Only rewrite it if it is a backend path:
  // `/v1/...`, `/auth/...`, `/public/...`, `/health/...` live on the
  // backend, while `/api/auth/...` (NextAuth) and app routes live on the
  // Next.js server. Returning a bare `/auth/setup` as-is would POST to a
  // non-existent Next.js route and 404.
  if (isBackendPath(resolved.pathname)) {
    return `/backend-proxy${resolved.pathname}${resolved.search}`;
  }

  return input;
}
