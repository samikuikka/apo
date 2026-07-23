/**
 * Unit tests for the Harbor command contract — argv shape, env allow-list,
 * fixture loading, and preflight. These run without Docker, network, or the
 * Harbor binary (except the preflight rejection case).
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  buildHarborArgv,
  buildHarborEnv,
  loadHarborFixture,
  preflightHarbor,
  HARBOR_VERSION,
  type HarborConfig,
} from "./harbor-command.ts";

const DEMO_ROOT = import.meta.dirname;

const baseCfg: HarborConfig = {
  task: "terminal-bench/count-dataset-tokens@3",
  agent: "codex",
  model: "gpt-5",
  env: "docker",
  jobName: "apo-run-42",
};

describe("buildHarborArgv", () => {
  it("builds an argv array (never a shell string) with the pinned contract", () => {
    const argv = buildHarborArgv(baseCfg, "/tmp/jobs");

    expect(Array.isArray(argv)).toBe(true);
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--task");
    expect(argv).toContain("terminal-bench/count-dataset-tokens@3");
    expect(argv).toContain("--n-attempts");
    expect(argv).toContain("1");
    expect(argv).toContain("--n-concurrent");
    expect(argv).toContain("1");
    expect(argv).toContain("--jobs-dir");
    expect(argv).toContain("/tmp/jobs");
    expect(argv).toContain("--job-name");
    expect(argv).toContain("apo-run-42");
  });

  it("includes model and env only when provided", () => {
    const withAll = buildHarborArgv(baseCfg, "/tmp/jobs");
    expect(withAll).toContain("--model");
    expect(withAll).toContain("gpt-5");
    expect(withAll).toContain("--env");

    const minimal = buildHarborArgv(
      { task: baseCfg.task, agent: "codex", jobName: "j1" },
      "/tmp/jobs",
    );
    expect(minimal).not.toContain("--model");
    expect(minimal).not.toContain("--env");
  });

  it("never puts a secret or shell metacharacter into argv", () => {
    const argv = buildHarborArgv(baseCfg, "/tmp/jobs");
    const joined = argv.join(" ");
    expect(joined).not.toContain("sk-");
    expect(joined).not.toContain(";");
    expect(joined).not.toContain("|");
    expect(joined).not.toContain("`");
  });
});

describe("buildHarborEnv", () => {
  it("keeps only allow-listed variables and drops everything else", () => {
    const env = buildHarborEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      OPENAI_API_KEY: "sk-secret",
      UNRELATED_SECRET: "topsecret",
      DATABASE_URL: "postgres://...",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/root");
    expect(env.OPENAI_API_KEY).toBe("sk-secret");
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("does not invent keys that were not in the source", () => {
    const env = buildHarborEnv({ PATH: "/usr/bin" });
    expect(Object.keys(env)).toEqual(["PATH"]);
  });
});

describe("loadHarborFixture", () => {
  it("returns the real Harbor trial shape", async () => {
    const result = await loadHarborFixture(
      join(DEMO_ROOT, "..", "fixtures/harbor/pass/result.json"),
    );

    expect(result.trial.verifier_result.rewards.reward).toBe(1);
    expect(result.trial.task_checksum).toMatch(/^[0-9a-f]+$/);
    expect(result.trial.agent_info?.name).toBe("opencode");
    expect(result.resultPath).toContain("pass/result.json");
    expect(result.trialDir).toContain("pass");
  });

  it("surfaces a malformed reward honestly (does not fabricate one)", async () => {
    const result = await loadHarborFixture(
      join(DEMO_ROOT, "..", "fixtures/harbor/malformed/result.json"),
    );
    expect(result.trial.verifier_result.rewards.reward).toBeUndefined();
  });
});

describe("preflightHarbor", () => {
  it("rejects when the binary is absent (execution error, not a verdict)", async () => {
    await expect(
      preflightHarbor("harbor-definitely-not-on-path-xyz"),
    ).rejects.toThrow(/preflight failed/);
  });

  it("pins the expected Harbor version constant", () => {
    // Guards against silent drift of the pinned contract.
    expect(HARBOR_VERSION).toBe("0.20.0");
  });
});
