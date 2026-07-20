import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as credentials from "../src/lib/credentials.ts";
import type { StoredCredentials } from "../src/lib/credentials.ts";

const { run } = await import("../src/commands/project-config.ts");

// In-memory credentials store. The command talks to readCredentials /
// writeCredentials only, so mocking those isolates it from the real
// ~/.apo/credentials file without touching the filesystem.
let store: StoredCredentials | null;

function mockStore(initial: StoredCredentials | null): void {
  store = initial;
  vi.spyOn(credentials, "readCredentials").mockImplementation(() => store);
  vi.spyOn(credentials, "writeCredentials").mockImplementation((creds) => {
    store = { ...creds, created_at: new Date().toISOString() };
    return "/mocked/credentials";
  });
}

beforeEach(() => {
  store = null;
  mockStore(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseCreds: StoredCredentials = {
  backend_url: "http://backend.test",
  api_key: "key",
  project: "example-service",
};

function captureLog(): [() => string, () => void] {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  return [() => logs.join("\n"), () => { console.log = orig; }];
}

function captureErr(): [() => string, () => void] {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  return [() => logs.join("\n"), () => { console.error = orig; }];
}

describe("project config set/unset/show (SPEC-136)", () => {
  it("set default-execution local persists to credentials and round-trips", async () => {
    mockStore({ ...baseCreds });

    const code = await run(["set", "default-execution", "local"]);

    expect(code).toBe(0);
    expect(store?.default_execution).toBe("local");
    // The rest of the credentials are preserved.
    expect(store?.api_key).toBe("key");
    expect(store?.project).toBe("example-service");
  });

  it("set default-execution backend persists", async () => {
    mockStore({ ...baseCreds });

    const code = await run(["set", "default-execution", "backend"]);

    expect(code).toBe(0);
    expect(store?.default_execution).toBe("backend");
  });

  it("set rejects unknown values with exit 2", async () => {
    mockStore({ ...baseCreds });

    const [getErr, restore] = captureErr();
    const code = await run(["set", "default-execution", "remotely"]);
    restore();

    expect(code).toBe(2);
    expect(getErr()).toMatch(/local.*backend|allowed/i);
    // Credentials untouched.
    expect(store?.default_execution).toBeUndefined();
  });

  it("set rejects unknown keys with exit 2", async () => {
    mockStore({ ...baseCreds });

    const code = await run(["set", "some-other-key", "local"]);
    expect(code).toBe(2);
  });

  it("unset clears an existing default-execution", async () => {
    mockStore({ ...baseCreds, default_execution: "local" });

    const code = await run(["unset", "default-execution"]);

    expect(code).toBe(0);
    expect(store?.default_execution).toBeUndefined();
    // Other fields preserved.
    expect(store?.api_key).toBe("key");
  });

  it("unset is a no-op (exit 0) when the key is already unset", async () => {
    mockStore({ ...baseCreds });

    const code = await run(["unset", "default-execution"]);
    expect(code).toBe(0);
    expect(store?.default_execution).toBeUndefined();
  });

  it("show prints the current default-execution", async () => {
    mockStore({ ...baseCreds, default_execution: "local" });

    const [getLog, restore] = captureLog();
    const code = await run(["show", "default-execution"]);
    restore();

    expect(code).toBe(0);
    expect(getLog()).toContain("local");
  });

  it("show reports 'unset' when no default-execution is configured", async () => {
    mockStore({ ...baseCreds });

    const [getLog, restore] = captureLog();
    const code = await run(["show", "default-execution"]);
    restore();

    expect(code).toBe(0);
    expect(getLog()).toMatch(/unset/i);
  });

  it("returns exit 2 when not logged in", async () => {
    mockStore(null);

    const [getErr, restore] = captureErr();
    const code = await run(["set", "default-execution", "local"]);
    restore();

    expect(code).toBe(2);
    expect(getErr()).toMatch(/login/i);
  });

  it("returns exit 2 with usage hint when no subcommand given", async () => {
    mockStore({ ...baseCreds });

    const code = await run([]);
    expect(code).toBe(2);
  });

  it("returns exit 2 for unknown subcommand", async () => {
    mockStore({ ...baseCreds });

    const code = await run(["frobnicate", "default-execution"]);
    expect(code).toBe(2);
  });
});
