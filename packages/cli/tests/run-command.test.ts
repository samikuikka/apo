import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { run } from "../src/commands/run.ts";
import { idFromPattern, fetchModelOptions } from "../src/lib/models-list.ts";
import {
  effectiveModelSource,
  hasProviderKey,
  resolveEnvView,
} from "../src/lib/env-view.ts";
import * as credentials from "../src/lib/credentials.ts";
import type { Config } from "../src/lib/config.ts";

function captureErr(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.join(" ")); };
  return { logs, restore: () => { console.error = original; } };
}

describe("run command guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to run without a terminal and points scripts at task run", async () => {
    // vitest stdin is never a TTY, so the guard always fires here.
    const { logs, restore } = captureErr();
    const code = await run([]);
    restore();
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/needs a terminal/);
    expect(logs.join("\n")).toMatch(/apo task run/);
  });

  it("rejects --json with a pointer to task run --json", async () => {
    const { logs, restore } = captureErr();
    const code = await run(["--json"]);
    restore();
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/--json/);
  });
});

describe("models-list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("synthesizes runnable ids from anchored pricing patterns", () => {
    expect(idFromPattern("(?i)^claude-sonnet-4[.-]5.*$")).toBe("claude-sonnet-4-5");
    expect(idFromPattern("^gpt-4o$")).toBe("gpt-4o");
    expect(idFromPattern("^gpt-4\\.1-mini$")).toBe("gpt-4.1-mini");
    expect(idFromPattern("(?i)^claude-sonnet-4[.-]5.*")).toBe("claude-sonnet-4-5");
  });

  it("maps the backend catalog to options, deduping date-tiered display names", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-test",
      project: "proj-1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            match_pattern: "(?i)^claude-sonnet-4[.-]5.*$",
            provider: "anthropic",
            display_name: "Claude Sonnet 4.5",
            pricing_tiers: [{ is_default: true, prices: { input: 3, output: 15 } }],
          },
          {
            match_pattern: "(?i)^claude-sonnet-4[.-]5-2026.*$",
            provider: "anthropic",
            display_name: "Claude Sonnet 4.5",
            pricing_tiers: [{ is_default: true, prices: { input: 2, output: 10 } }],
          },
          {
            match_pattern: "^grok-4\\.6$",
            provider: "generic",
            display_name: "Grok 4.6",
            pricing_tiers: [{ is_default: true, prices: { input: 2, output: 6 } }],
          },
        ]),
        { status: 200 },
      ),
    );

    const config = {
      apiKey: "sk-test",
      backendUrl: "http://backend.test",
      projectId: "proj-1",
    } as unknown as Config;

    const models = await fetchModelOptions(config);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: "claude-sonnet-4-5", display: "Claude Sonnet 4.5", provider: "anthropic", input: 3, output: 15 });
    expect(models[1]).toMatchObject({ id: "grok-4.6", provider: "other" });
  });

  it("returns an empty list (not an error) when the backend is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const config = { apiKey: "sk-test", backendUrl: "http://backend.test" } as unknown as Config;
    await expect(fetchModelOptions(config)).resolves.toEqual([]);
  });
});

describe("env-view", () => {
  let testDir: string;

  it("mirrors loadEnvFiles: task .env supplies vars, process env beats files, values never surface", () => {
    testDir = join(tmpdir(), `apo-envview-${Date.now()}`);
    mkdirSync(join(testDir, "task"), { recursive: true });
    writeFileSync(join(testDir, "task", ".env"), "OPENAI_API_KEY=file-key\nOPENAI_MODEL=file-model\nCOMPANY_SECRET=hush\n");

    const view = resolveEnvView(join(testDir, "task"), {
      OPENROUTER_MODEL: "from-process",
    } as Record<string, string>);

    expect(view.files[0]).toMatchObject({ exists: true });
    const oa = view.known.find((v) => v.name === "OPENAI_API_KEY")!;
    expect(oa.set).toBe(true);
    expect(oa.source).toBe(join(testDir, "task", ".env"));
    // Values never appear anywhere in the view — only names and sources.
    expect(JSON.stringify(view)).not.toContain("file-key");
    expect(JSON.stringify(view)).not.toContain("hush");
    // process env wins over files.
    const or = view.known.find((v) => v.name === "OPENROUTER_MODEL")!;
    expect(or.source).toBe("process env");
    // Non-apo vars the chain provides are listed by name only.
    expect(view.others).toContain("COMPANY_SECRET");
    expect(hasProviderKey(view)).toBe(true);
    expect(effectiveModelSource(view, undefined)).toEqual({ from: "env", varName: "OPENROUTER_MODEL" });
    // A chosen model takes precedence over env.
    expect(effectiveModelSource(view, "picked")).toEqual({ from: "chosen", model: "picked" });

    rmSync(testDir, { recursive: true, force: true });
  });
});
