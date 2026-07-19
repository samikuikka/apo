/**
 * Tests for SPEC-132 Behavior 3: same-origin browser URL contract.
 *
 * The dashboard must never let browser code resolve a request to the
 * Docker-internal backend URL (e.g. `http://backend:8000`). A remote
 * user's browser would then try to reach `backend` on *its own*
 * machine, not the apo host.
 *
 * The contract:
 * - `getServerBackendBaseUrl()` MAY return the Docker-internal URL
 *   (server components run inside the frontend container).
 * - `getBrowserBackendBaseUrl()` MUST NEVER return the Docker-internal
 *   URL — it is the legacy fallback only, and browser code should
 *   prefer relative `/backend-proxy` via `backendFetch`.
 * - Client components must not import `getServerBackendBaseUrl`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("getServerBackendBaseUrl (server-only)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the Docker-internal BACKEND_URL on the server", async () => {
    vi.stubEnv("BACKEND_URL", "http://backend:8000");
    vi.stubEnv("NEXT_PUBLIC_APO_BACKEND_URL", "");

    const { getServerBackendBaseUrl } = await import("../config.server");

    // typeof window === "undefined" in vitest (node env) → server branch
    expect(getServerBackendBaseUrl()).toBe("http://backend:8000");
  });

  it("falls back to localhost when neither var is set", async () => {
    vi.stubEnv("BACKEND_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APO_BACKEND_URL", "");
    // Delete so the ?? operator sees undefined (not empty string).
    delete process.env.BACKEND_URL;
    delete process.env.NEXT_PUBLIC_APO_BACKEND_URL;

    const { getServerBackendBaseUrl } = await import("../config.server");

    expect(getServerBackendBaseUrl()).toBe("http://localhost:8000");
  });
});

describe("getBrowserBackendBaseUrl (browser-only)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never returns the Docker-internal URL even if BACKEND_URL is set", async () => {
    // Simulate browser context.
    vi.stubGlobal("window", { location: { origin: "https://apo.example.com" } });

    // The Docker-internal URL set by Compose. A browser must NOT see it.
    vi.stubEnv("BACKEND_URL", "http://backend:8000");
    // No public var set → browser helper must NOT fall through to BACKEND_URL.
    vi.stubEnv("NEXT_PUBLIC_APO_BACKEND_URL", "");

    const { getBrowserBackendBaseUrl } = await import("../config");

    const url = getBrowserBackendBaseUrl();
    expect(url).not.toContain("backend:8000");
    expect(url).not.toContain("//backend");
  });

  it("returns the same-origin public URL when set", async () => {
    vi.stubGlobal("window", { location: { origin: "https://apo.example.com" } });
    vi.stubEnv("NEXT_PUBLIC_APO_BACKEND_URL", "https://apo.example.com/backend-proxy");

    const { getBrowserBackendBaseUrl } = await import("../config");

    expect(getBrowserBackendBaseUrl()).toBe(
      "https://apo.example.com/backend-proxy",
    );
  });
});

describe("backendFetch browser path (the real contract)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rewrites a backend-internal URL to relative /backend-proxy in the browser", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://apo.example.com" },
    });
    // Even with the Docker-internal URL present, browser fetch must go relative.
    vi.stubEnv("BACKEND_URL", "http://backend:8000");
    vi.stubEnv("NEXT_PUBLIC_APO_BACKEND_URL", "");

    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      return Promise.resolve(new Response("{}"));
    });

    const { backendFetch } = await import("../backend-fetch");
    await backendFetch("http://localhost:8000/auth/verify-password");

    // The browser fetch must target a same-origin relative URL, never backend:8000.
    expect(calls[0]).not.toContain("backend:8000");
    expect(calls[0]).not.toContain("localhost:8000");
    expect(calls[0].startsWith("/backend-proxy/")).toBe(true);
  });
});
