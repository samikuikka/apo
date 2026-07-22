import { afterEach, describe, expect, it, vi } from "vitest";

describe("public ingress routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves the canonical OTLP path before the generic API rewrite", async () => {
    vi.stubEnv("BACKEND_URL", "http://backend:8000");
    const { default: nextConfig } = await import("../../../next.config.mjs");

    const rewrites = await nextConfig.rewrites?.();

    expect(Array.isArray(rewrites)).toBe(true);
    if (!Array.isArray(rewrites)) {
      throw new Error("expected array-form Next.js rewrites");
    }
    expect(rewrites[0]).toEqual({
      source: "/api/public/otel/:path*",
      destination: "http://backend:8000/api/public/otel/:path*",
    });
  });
});
