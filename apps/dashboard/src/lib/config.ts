/**
 * Browser-facing backend URL helper.
 *
 * NEVER returns the Docker-internal URL. Browser code should prefer
 * relative `/backend-proxy` via `backendFetch`; this helper exists for
 * legacy callers and SDK-compat config, and only reads the
 * `NEXT_PUBLIC_` var (set to the same-origin public URL) or falls back
 * to a relative path so the browser stays on the public origin.
 *
 * Server-only code should import from `config.server.ts` instead.
 */
export function getBrowserBackendBaseUrl(): string {
  const publicVar = process.env.NEXT_PUBLIC_APO_BACKEND_URL;
  if (publicVar) {
    return publicVar;
  }
  // No public var: use a relative same-origin path. NEVER fall back to
  // BACKEND_URL or localhost:8000 — a remote browser cannot reach them.
  return "/backend-proxy";
}

export function getProjectId() {
  // Legacy helper for non-route-scoped client contexts.
  // Inside /project/[projectId], prefer the route param or useProjectId()
  // so data reads/writes cannot drift to a stale cookie-backed project.
  if (typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)active-project=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return process.env.NEXT_PUBLIC_APO_PROJECT ?? "example-service";
}
