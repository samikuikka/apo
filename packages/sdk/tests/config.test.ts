/**
 * Unit tests for config.ts
 *
 * Tests environment variable reading with various scenarios:
 * - All env vars set
 * - Some env vars set (uses defaults)
 * - No env vars set (uses all defaults)
 * - Priority order (NEXT_PUBLIC_* vs standard)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readConfig } from "../src/config";

describe("readConfig", () => {
  // Save original env
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv };
  });

  describe("endpoint configuration", () => {
    it("should use NEXT_PUBLIC_APO_BACKEND_URL when set", () => {
      process.env.NEXT_PUBLIC_APO_BACKEND_URL = "https://api.example.com";
      process.env.APO_BACKEND_URL = "https://should-not-override.com";

      const config = readConfig();

      expect(config.endpoint).toBe("https://api.example.com");
    });

    it("should use APO_BACKEND_URL when NEXT_PUBLIC_* is not set", () => {
      process.env.APO_BACKEND_URL = "https://backend.example.com";

      const config = readConfig();

      expect(config.endpoint).toBe("https://backend.example.com");
    });

    it("should use default when no env vars are set", () => {
      delete process.env.NEXT_PUBLIC_APO_BACKEND_URL;
      delete process.env.APO_BACKEND_URL;

      const config = readConfig();

      expect(config.endpoint).toBe("http://localhost:8000");
    });
  });

  describe("project configuration", () => {
    it("should use APO_PROJECT when set", () => {
      process.env.APO_PROJECT = "my-custom-project";
      process.env.NEXT_PUBLIC_APO_PROJECT = "should-not-override";

      const config = readConfig();

      expect(config.project).toBe("my-custom-project");
    });

    it("should use NEXT_PUBLIC_APO_PROJECT when APO_PROJECT is not set", () => {
      process.env.NEXT_PUBLIC_APO_PROJECT = "nextjs-project";

      const config = readConfig();

      expect(config.project).toBe("nextjs-project");
    });

    it("should use default when no env vars are set", () => {
      delete process.env.APO_PROJECT;
      delete process.env.NEXT_PUBLIC_APO_PROJECT;

      const config = readConfig();

      expect(config.project).toBe("default-project");
    });
  });

  describe("combined configuration", () => {
    it("should read both endpoint and project correctly", () => {
      process.env.NEXT_PUBLIC_APO_BACKEND_URL = "https://prod.api.com";
      process.env.APO_PROJECT = "production-app";

      const config = readConfig();

      expect(config.endpoint).toBe("https://prod.api.com");
      expect(config.project).toBe("production-app");
    });

    it("should use all defaults when nothing is configured", () => {
      delete process.env.NEXT_PUBLIC_APO_BACKEND_URL;
      delete process.env.APO_BACKEND_URL;
      delete process.env.APO_PROJECT;
      delete process.env.NEXT_PUBLIC_APO_PROJECT;

      const config = readConfig();

      expect(config.endpoint).toBe("http://localhost:8000");
      expect(config.project).toBe("default-project");
    });
  });

  describe("authentication configuration", () => {
    it("should read public, secret, and legacy API keys from environment", () => {
      process.env.NEXT_PUBLIC_APO_PUBLIC_KEY = "pk-apo-public-browser";
      process.env.APO_SECRET_KEY = "sk-apo-secret-server";
      process.env.APO_API_KEY = "sk-legacy-key";

      const config = readConfig();

      expect(config.publicKey).toBe("pk-apo-public-browser");
      expect(config.secretKey).toBe("sk-apo-secret-server");
      expect(config.apiKey).toBe("sk-legacy-key");
    });

    it("should fall back to server public key when NEXT_PUBLIC public key is not set", () => {
      delete process.env.NEXT_PUBLIC_APO_PUBLIC_KEY;
      process.env.APO_PUBLIC_KEY = "pk-apo-server-public";

      const config = readConfig();

      expect(config.publicKey).toBe("pk-apo-server-public");
    });
  });

  describe("environment variable priority", () => {
    it("should prioritize NEXT_PUBLIC_* for endpoint over standard env var", () => {
      process.env.NEXT_PUBLIC_APO_BACKEND_URL = "https://nextjs-priority.com";
      process.env.APO_BACKEND_URL = "https://standard-priority.com";

      const config = readConfig();

      expect(config.endpoint).toBe("https://nextjs-priority.com");
    });

    it("should prioritize standard env var for project over NEXT_PUBLIC_*", () => {
      process.env.APO_PROJECT = "standard-priority";
      process.env.NEXT_PUBLIC_APO_PROJECT = "nextjs-priority";

      const config = readConfig();

      expect(config.project).toBe("standard-priority");
    });
  });
});
