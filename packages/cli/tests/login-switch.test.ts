import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentials from "../src/lib/credentials.ts";
import { run as runLogin } from "../src/commands/login.ts";
import { run as runLogout } from "../src/commands/logout.ts";
import { stripAnsi } from "../src/lib/format.ts";

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  return { logs, restore: () => { console.log = original; } };
}

const REMEMBERED = {
  backend_url: "http://localhost:8000",
  api_key: "sk-remembered",
  email: "dev@apo.local",
  task_root: "/repo/e2e/tasks",
  project: "proj-main",
};

const ACTIVE_ON_OTHER = {
  backend_url: "http://other.example:8020",
  api_key: "sk-other",
  email: "someone@other.example",
  project: "proj-other",
};

describe("apo login as the switch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches to a remembered login without a password", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(ACTIVE_ON_OTHER);
    vi.spyOn(credentials, "readRememberedLogin").mockReturnValue(REMEMBERED);
    const writeSpy = vi.spyOn(credentials, "writeCredentials").mockReturnValue("/tmp/fake-credentials");
    // checkSavedKey hits GET /v1/api-keys with the remembered key.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    const { logs, restore } = captureLog();

    const code = await runLogin(["--backend", "http://localhost:8000"]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain("Switched to dev@apo.local on http://localhost:8000");
    expect(out).toContain("/repo/e2e/tasks");
    expect(writeSpy).toHaveBeenCalledWith(REMEMBERED);
  });

  it("refuses to switch when the target backend cannot be reached", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(ACTIVE_ON_OTHER);
    vi.spyOn(credentials, "readRememberedLogin").mockReturnValue(REMEMBERED);
    vi.spyOn(credentials, "writeCredentials").mockReturnValue("/tmp/fake-credentials");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { errors.push(msg); };

    const code = await runLogin(["--backend", "http://localhost:8000"]);

    console.error = origErr;
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Cannot reach http://localhost:8000");
  });

  it("falls through to password re-authentication when the remembered key is rejected", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(ACTIVE_ON_OTHER);
    vi.spyOn(credentials, "readRememberedLogin").mockReturnValue(REMEMBERED);
    vi.spyOn(credentials, "writeCredentials").mockReturnValue("/tmp/fake-credentials");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/v1/api-keys")) return new Response("nope", { status: 401 });
      if (url.includes("/auth/verify-password")) {
        return new Response(JSON.stringify({ detail: "bad credentials" }), { status: 401 });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { errors.push(msg); };
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { logs.push(msg); };

    const code = await runLogin([
      "--backend", "http://localhost:8000",
      "--email", "dev@apo.local",
      "--password", "wrong",
    ]);

    console.error = origErr;
    console.log = origLog;
    // The rejection notice proves the remembered login was tried and set
    // aside; the auth error proves the flow continued to email + password.
    expect(stripAnsi(logs.join("\n"))).toContain("was rejected by http://localhost:8000");
    expect(errors.join("\n")).toContain("Invalid email or password");
    expect(code).toBe(2);
  });
});

describe("apo logout forgets the remembered login", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the remembered slot for the active backend", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(REMEMBERED);
    vi.spyOn(credentials, "clearCredentials").mockReturnValue(true);
    const forgetSpy = vi.spyOn(credentials, "forgetRememberedLogin").mockReturnValue(true);
    const { logs, restore } = captureLog();

    const code = await runLogout([]);

    restore();
    expect(code).toBe(0);
    expect(forgetSpy).toHaveBeenCalledWith("http://localhost:8000");
    expect(stripAnsi(logs.join("\n"))).toContain("Logged out (dev@apo.local)");
  });
});
