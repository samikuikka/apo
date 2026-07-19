/**
 * Server-only backend URL helper.
 *
 * Runs inside the frontend container, so it MAY return the
 * Docker-internal URL (e.g. `http://backend:8000`). Server components
 * and route handlers call the backend through this origin.
 *
 * MUST NOT be imported by client components — a browser resolving this
 * would try to reach `backend` on the user's own machine.
 *
 * This lives in a separate module from `config.ts` so that the
 * `process.env.BACKEND_URL` reference is never pulled into client
 * bundles by the bundler's module graph.
 */
export function getServerBackendBaseUrl(): string {
  return (
    process.env.BACKEND_URL ??
    process.env.NEXT_PUBLIC_APO_BACKEND_URL ??
    "http://localhost:8000"
  );
}
