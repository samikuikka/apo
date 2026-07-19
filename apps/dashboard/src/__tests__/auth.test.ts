import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface CookieConfig {
  sessionToken: {
    name: string;
    options: {
      httpOnly: boolean;
      sameSite: string;
      path: string;
      secure: boolean;
    };
  };
}

interface NextAuthConfig {
  cookies: CookieConfig;
  [key: string]: unknown;
}

async function importAuthAndCaptureConfig(): Promise<NextAuthConfig> {
  let capturedConfig: NextAuthConfig | null = null;

  vi.doMock("next-auth", () => ({
    default: (config: NextAuthConfig) => {
      capturedConfig = config;
      return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
    },
  }));

  vi.doMock("next-auth/providers/credentials", () => ({
    default: (opts: Record<string, unknown>) => opts,
  }));

  vi.doMock("@/lib/config", () => ({
    getBackendBaseUrl: () => "http://localhost:8000",
  }));

  await import("@/auth");
  return capturedConfig!;
}

describe("auth.ts cookie configuration", () => {
  let originalNextAuthUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    originalNextAuthUrl = process.env.NEXTAUTH_URL;
  });

  afterEach(() => {
    if (originalNextAuthUrl === undefined) {
      delete process.env.NEXTAUTH_URL;
    } else {
      process.env.NEXTAUTH_URL = originalNextAuthUrl;
    }
    vi.doUnmock("next-auth");
    vi.doUnmock("next-auth/providers/credentials");
    vi.doUnmock("@/lib/config");
  });

  it("uses __Secure- prefixed cookie with secure=true when NEXTAUTH_URL is https", async () => {
    process.env.NEXTAUTH_URL = "https://optimizer.example.com";
    const config = await importAuthAndCaptureConfig();

    const cookie = config.cookies.sessionToken;
    expect(cookie.name).toBe("__Secure-authjs.session-token");
    expect(cookie.options.secure).toBe(true);
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe("lax");
    expect(cookie.options.path).toBe("/");
  });

  it("uses plain cookie name with secure=false when NEXTAUTH_URL is http", async () => {
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    const config = await importAuthAndCaptureConfig();

    const cookie = config.cookies.sessionToken;
    expect(cookie.name).toBe("authjs.session-token");
    expect(cookie.options.secure).toBe(false);
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe("lax");
  });

  it("defaults to http mode (plain cookie, secure=false) when NEXTAUTH_URL is unset", async () => {
    delete process.env.NEXTAUTH_URL;
    const config = await importAuthAndCaptureConfig();

    const cookie = config.cookies.sessionToken;
    expect(cookie.name).toBe("authjs.session-token");
    expect(cookie.options.secure).toBe(false);
  });
});
