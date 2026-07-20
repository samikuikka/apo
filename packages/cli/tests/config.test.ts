import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import * as credentials from "../src/lib/credentials.ts";
import { resolveConfig } from "../src/lib/config.ts";

describe("resolveConfig", () => {
  beforeEach(() => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(null);
  });

  afterEach(() => {
    delete process.env.APO_TASK_ROOT;
    delete process.env.APO_BACKEND_URL;
    delete process.env.APO_PROJECT_ID;
    vi.restoreAllMocks();
  });

  it("uses defaults when no flags or env vars", () => {
    const config = resolveConfig({});
    expect(config.taskRoot).toBe(resolve("./e2e"));
    expect(config.backendUrl).toBe("http://localhost:8000");
    expect(config.projectId).toBeUndefined();
    expect(config.json).toBe(false);
  });

  it("uses stored credentials as defaults", () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://stored:8000",
      api_key: "stored-key",
      task_root: "/stored/tasks",
      project: "stored-proj",
    });
    const config = resolveConfig({});
    expect(config.taskRoot).toBe("/stored/tasks");
    expect(config.backendUrl).toBe("http://stored:8000");
    expect(config.apiKey).toBe("stored-key");
    expect(config.projectId).toBe("stored-proj");
  });

  it("surfaces stored default_execution as config.defaultExecution", () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://stored:8000",
      api_key: "stored-key",
      project: "stored-proj",
      default_execution: "local",
    });
    const config = resolveConfig({});
    expect(config.defaultExecution).toBe("local");
  });

  it("defaultExecution is undefined when credentials lack default_execution (backward compat)", () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://stored:8000",
      api_key: "stored-key",
      project: "stored-proj",
    });
    const config = resolveConfig({});
    expect(config.defaultExecution).toBeUndefined();
  });

  it("defaultExecution is undefined with no stored credentials", () => {
    const config = resolveConfig({});
    expect(config.defaultExecution).toBeUndefined();
  });

  it("uses stored project as default but flag overrides it", () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://stored:8000",
      api_key: "stored-key",
      project: "stored-proj",
    });
    const config = resolveConfig({ project: "other-proj" });
    expect(config.projectId).toBe("other-proj");
  });

  it("resolves relative stored task_root against detected repo root", () => {
    const baseDir = join(tmpdir(), `apo-config-test-${Date.now()}`);
    const repoRoot = join(baseDir, "repo");
    const credsDir = join(repoRoot, ".apo");
    mkdirSync(credsDir, { recursive: true });
    writeFileSync(join(repoRoot, "package.json"), "{}");

    vi.spyOn(credentials, "credentialsPath").mockReturnValue(
      join(credsDir, "credentials"),
    );
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://stored:8000",
      api_key: "stored-key",
      task_root: "apps/example/tasks",
    });

    try {
      const config = resolveConfig({}, { cwd: credsDir });
      expect(config.taskRoot).toBe(join(repoRoot, "apps", "example", "tasks"));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("uses flag values over defaults", () => {
    const config = resolveConfig({
      dir: "/custom/dir",
      backend: "http://custom:9000",
      project: "proj-123",
    });
    expect(config.taskRoot).toBe("/custom/dir");
    expect(config.backendUrl).toBe("http://custom:9000");
    expect(config.projectId).toBe("proj-123");
  });

  it("uses env vars when no flags", () => {
    process.env.APO_TASK_ROOT = "/env/dir";
    process.env.APO_BACKEND_URL = "http://env:7000";
    process.env.APO_PROJECT_ID = "env-proj";
    const config = resolveConfig({});
    expect(config.taskRoot).toBe("/env/dir");
    expect(config.backendUrl).toBe("http://env:7000");
    expect(config.projectId).toBe("env-proj");
  });

  it("flags override env vars", () => {
    process.env.APO_TASK_ROOT = "/env/dir";
    const config = resolveConfig({ dir: "/flag/dir" });
    expect(config.taskRoot).toBe("/flag/dir");
  });

  it("json flag sets json to true", () => {
    const config = resolveConfig({ json: true });
    expect(config.json).toBe(true);
  });

  it("json flag as string does not enable json", () => {
    const config = resolveConfig({ json: "true" });
    expect(config.json).toBe(false);
  });

  it("boolean flags ignored for string config values", () => {
    const config = resolveConfig({ dir: true, backend: true });
    expect(config.taskRoot).toBe(resolve("./e2e"));
    expect(config.backendUrl).toBe("http://localhost:8000");
  });
});
