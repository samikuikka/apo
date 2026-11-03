import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { run } from "../src/commands/project-create.ts";
import * as credentials from "../src/lib/credentials.ts";

// Isolate HOME so any stray real write (e.g. via resolveConfig reading
// ~/.apo/credentials) never touches the developer's actual home dir.
beforeEach(() => {
  vi.stubEnv("HOME", join(tmpdir(), `apo-project-create-test-${Date.now()}`));
});

const mockResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("project create command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("creates a project and writes credentials on success", async () => {
    const writeSpy = vi.spyOn(credentials, "writeCredentials").mockReturnValue("/tmp/fake-credentials");
    const rememberSpy = vi.spyOn(credentials, "writeRememberedLogin").mockReturnValue("/tmp/fake-login");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(201, {
        id: "key-1",
        name: "apo-cli",
        prefix: "sk-abcde",
        project: "abc123def456",
        created_by: "user-1",
        scope: "full",
        created_at: "2026-07-19T00:00:00Z",
        key: "sk-abcde1234567890",
      }),
    );

    const logs: string[] = [];
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await run([
      "my-proj",
      "--backend",
      "http://backend.test",
      "--email",
      "me@example.com",
      "--password",
      "secret",
    ]);

    console.log = originalLog;
    console.error = originalErr;

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://backend.test/v1/projects/bootstrap");
    expect(init?.method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      email: "me@example.com",
      password: "secret",
      name: "my-proj",
      scope: "full",
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0]![0];
    // A relative task_root stored in ~/.apo/credentials later resolves
    // against ~/.apo, not the cwd the command ran from, so the write must
    // capture the absolute path.
    expect(isAbsolute(written.task_root!)).toBe(true);
    expect(written.task_root).toBe(resolve("./e2e"));
    expect(written).toMatchObject({
      backend_url: "http://backend.test",
      api_key: "sk-abcde1234567890",
      project: "abc123def456",
      email: "me@example.com",
    });
    // The bootstrap is a real login: remember it so a later `apo login
    // --backend <other>` can switch back without the password.
    expect(rememberSpy).toHaveBeenCalledWith(written);
    expect(logs.join("\n")).toContain("abc123def456");
    expect(logs.join("\n")).toContain("my-proj");
  });

  it("exits 2 on 401 (bad credentials)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(401, { detail: "Invalid credentials" }),
    );
    const logs: string[] = [];
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await run([
      "p",
      "--backend",
      "http://b",
      "--email",
      "a@b.c",
      "--password",
      "wrong",
    ]);

    console.log = originalLog;
    console.error = originalErr;
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/invalid email or password/i);
  });

  it("exits 2 on 400 (e.g. demo name rejected)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(400, { detail: "'demo' is a reserved project name" }),
    );
    const logs: string[] = [];
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await run([
      "demo",
      "--backend",
      "http://b",
      "--email",
      "a@b.c",
      "--password",
      "x",
    ]);

    console.log = originalLog;
    console.error = originalErr;
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/reserved/i);
  });

  it("exits 2 on 429 (rate limited)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(429, { detail: "Too many login attempts" }),
    );
    const logs: string[] = [];
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await run([
      "p",
      "--backend",
      "http://b",
      "--email",
      "a@b.c",
      "--password",
      "x",
    ]);

    console.log = originalLog;
    console.error = originalErr;
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/too many attempts/i);
  });

  it("exits 2 when name is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const logs: string[] = [];
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    const code = await run([
      "--backend",
      "http://b",
      "--email",
      "a@b.c",
      "--password",
      "x",
    ]);
    console.log = originalLog;
    console.error = originalErr;
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/name/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exits 2 when email is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const logs: string[] = [];
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    const code = await run(["p", "--backend", "http://b", "--password", "x"]);
    console.log = originalLog;
    console.error = originalErr;
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/email/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exits 2 when password is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const logs: string[] = [];
    const originalLog = console.log;
    const originalErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    const code = await run(["p", "--backend", "http://b", "--email", "a@b.c"]);
    console.log = originalLog;
    console.error = originalErr;
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/password/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

