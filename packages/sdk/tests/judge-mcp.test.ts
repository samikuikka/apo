import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../src/agent-task/checks/flow-runner.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";
import {
  namespaceToolName,
  filterToolNames,
  expandSecretPlaceholders,
  resolveJudgeTools,
  resolveJudgeToolsFromEnv,
  type McpServerConfig,
} from "../src/agent-task/checks/mcp-tools.ts";

/**
 * t.agent + MCP evidence tools. Two planes are exercised:
 *
 *  - Pure helpers (namespacing, filtering, secret expansion, layering) in
 *    isolation.
 *  - The full session through the public check surface (defineCheck +
 *    runTraceChecks) with a scripted model (canned OpenAI-compatible fetch
 *    turns, same harness as agent-judge.test.ts) calling a REAL stdio MCP
 *    server spawned by the real @ai-sdk/mcp client. No network, no API keys.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FACTS_SERVER = join(__dirname, "fixtures", "mcp-facts-server.mjs");

const snapshot: TraceProjectionSnapshot = {
  schemaVersion: 1,
  projectionVersion: 1,
  source: "local",
  trace: { traceId: "t", complete: true },
  capabilities: {
    messages: "available",
    tools: "available",
    errors: "available",
    timing: "available",
    skills: "available",
    subagents: "unavailable",
  },
  observations: [],
};

function toolCallTurn(id: string, name: string, args: unknown) {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 8 },
  };
}

function scriptFetch(responses: unknown[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const JUDGE = { model: "test-model", apiKey: "test-key" };

function factsServerConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "facts",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [FACTS_SERVER],
      env: { FACTS_PID_FILE: "${FACTS_PID_FILE}" },
    },
    ...overrides,
  };
}

async function runAgentCheck(
  fn: Parameters<typeof defineCheck>[1],
  opts: { judgeTools?: { mcp?: McpServerConfig[] } } = {},
) {
  resetFlowChecks();
  defineCheck("mcp-check", fn);
  const results = await runTraceChecks({
    snapshot,
    deliverables: { answer: "42" },
    judgeConfig: JUDGE,
    ...(opts.judgeTools ? { judgeTools: opts.judgeTools } : {}),
  });
  return results[0]!.assertions[0]!;
}

let tmpDir: string;
let savedEnv: { pidFile?: string; secret?: string; judgeMcp?: string };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "judge-mcp-"));
  savedEnv = {
    pidFile: process.env.FACTS_PID_FILE,
    secret: process.env.SECRET_TOKEN,
    judgeMcp: process.env.APO_JUDGE_MCP,
  };
  process.env.FACTS_PID_FILE = join(tmpDir, "facts.pid");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Unit: pure helpers ─────────────────────────────────────────────────────

describe("mcp-tools — pure helpers", () => {
  it("namespaces server tools as mcp__<server>__<tool>", () => {
    expect(namespaceToolName("ops", "check_endpoint")).toBe("mcp__ops__check_endpoint");
  });

  it("filters tool names: allowlist wins, denylist removes after it", () => {
    const all = ["get_fact", "big_fact", "slow_fact"];
    expect(filterToolNames(all, { tools: ["get_fact"] })).toEqual(["get_fact"]);
    expect(filterToolNames(all, { excludeTools: ["big_fact"] })).toEqual(["get_fact", "slow_fact"]);
    expect(filterToolNames(all, { tools: ["get_fact", "big_fact"], excludeTools: ["big_fact"] })).toEqual([
      "get_fact",
    ]);
    expect(filterToolNames(all, {})).toEqual(all);
  });

  it("expands ${VAR} placeholders from process.env; unset vars are visible errors", () => {
    process.env.MCP_TEST_VAR = "resolved-value";
    expect(expandSecretPlaceholders({ a: "${MCP_TEST_VAR}", b: "literal", c: "pre-${MCP_TEST_VAR}-post" })).toEqual({
      a: "resolved-value",
      b: "literal",
      c: "pre-resolved-value-post",
    });
    expect(() => expandSecretPlaceholders({ a: "${MCP_TEST_UNSET_VAR}" })).toThrow(/MCP_TEST_UNSET_VAR/);
  });

  it("resolves judge tools layer by layer, arrays replacing never concat", () => {
    const run = { mcp: [factsServerConfig()] };
    const task = { mcp: [factsServerConfig({ name: "other" })] };
    expect(resolveJudgeTools(run, task)?.mcp).toEqual(task.mcp);
    expect(resolveJudgeTools(run, undefined)?.mcp).toEqual(run.mcp);
    expect(resolveJudgeTools(undefined, undefined)).toBeUndefined();
    // Field merge: an unset task field falls through to the run field.
    expect(resolveJudgeTools(run, {})?.mcp).toEqual(run.mcp);
  });

  it("loads APO_JUDGE_MCP from the industry map form and the array form", async () => {
    const mapFile = join(tmpDir, "map.json");
    writeFileSync(
      mapFile,
      JSON.stringify({
        mcpServers: {
          facts: { command: process.execPath, args: [FACTS_SERVER], env: { A: "1" } },
          remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
        },
      }),
    );
    process.env.APO_JUDGE_MCP = mapFile;
    const fromMap = await resolveJudgeToolsFromEnv();
    expect(fromMap?.mcp).toHaveLength(2);
    expect(fromMap?.mcp?.[0]).toMatchObject({
      name: "facts",
      transport: { type: "stdio", command: process.execPath },
    });
    expect(fromMap?.mcp?.[1]).toMatchObject({ name: "remote", transport: { type: "http" } });

    const arrayFile = join(tmpDir, "array.json");
    writeFileSync(arrayFile, JSON.stringify({ mcp: [factsServerConfig()] }));
    process.env.APO_JUDGE_MCP = arrayFile;
    const fromArray = await resolveJudgeToolsFromEnv();
    expect(fromArray?.mcp).toHaveLength(1);
    expect(fromArray?.mcp?.[0]?.name).toBe("facts");
  });

  it("returns undefined without APO_JUDGE_MCP and throws visibly on invalid JSON", async () => {
    delete process.env.APO_JUDGE_MCP;
    expect(await resolveJudgeToolsFromEnv()).toBeUndefined();

    const badFile = join(tmpDir, "bad.json");
    writeFileSync(badFile, "{ not json");
    process.env.APO_JUDGE_MCP = badFile;
    await expect(resolveJudgeToolsFromEnv()).rejects.toThrow(/APO_JUDGE_MCP/);
  });
});

// ── Scene: real stdio MCP round-trips through the public check surface ─────

describe("t.agent — MCP evidence tools (real stdio server)", () => {
  it("serves a real MCP tool to the judge and fingerprints the evidence", async () => {
    scriptFetch([
      toolCallTurn("1", "mcp__facts__get_fact", { topic: "answer" }),
      toolCallTurn("2", "finish_verdict", { reasoning: "The facts service says answer is 42.", pass: true }),
    ]);

    const assertion = await runAgentCheck(async (t) => {
      await t.agent("PASS if the facts service says answer is 42.", {
        tools: { mcp: [factsServerConfig()] },
        label: "mcp-roundtrip",
      });
    });

    expect(assertion.pass).toBe(true);
    expect(assertion.reasoning).toContain("42");
    const session = assertion.judge?.session;
    expect(session?.tools).toContain("mcp__facts__get_fact");
    expect(session?.tools).toContain("finish_verdict");

    const call = session?.steps
      ?.flatMap((s) => s.tool_calls ?? [])
      .find((c) => c.name === "mcp__facts__get_fact");
    expect(call?.result).toContain("fact: answer is 42");

    const fingerprint = session?.evidence?.find((e) => e.tool === "mcp__facts__get_fact");
    expect(fingerprint?.result_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint?.result_bytes).toBeGreaterThan(0);
  });

  it("accepts the same config through the layered judgeTools argument", async () => {
    scriptFetch([
      toolCallTurn("1", "mcp__facts__get_fact", { topic: "layering" }),
      toolCallTurn("2", "finish_verdict", { reasoning: "Layered config reached the server.", pass: true }),
    ]);

    const assertion = await runAgentCheck(
      async (t) => {
        await t.agent("PASS if the fact service answers.");
      },
      { judgeTools: { mcp: [factsServerConfig()] } },
    );

    expect(assertion.pass).toBe(true);
    expect(assertion.judge?.session?.tools).toContain("mcp__facts__get_fact");
  });

  it("applies allow/deny filtering to the exposed tool names", async () => {
    scriptFetch([
      toolCallTurn("1", "finish_verdict", { reasoning: "Only get_fact was offered.", pass: true }),
    ]);

    const assertion = await runAgentCheck(
      async (t) => {
        await t.agent("PASS regardless.");
      },
      {
        judgeTools: {
          mcp: [factsServerConfig({ tools: ["get_fact"], excludeTools: [] })],
        },
      },
    );

    const tools = assertion.judge?.session?.tools ?? [];
    expect(tools).toContain("mcp__facts__get_fact");
    expect(tools).not.toContain("mcp__facts__big_fact");
    expect(tools).not.toContain("mcp__facts__slow_fact");
  });

  it("counts MCP calls against the shared tool-call budget", async () => {
    scriptFetch([
      toolCallTurn("1", "mcp__facts__get_fact", { topic: "one" }),
      toolCallTurn("2", "mcp__facts__get_fact", { topic: "two" }),
      toolCallTurn("3", "finish_verdict", { reasoning: "Budget behaved.", pass: true }),
    ]);

    resetFlowChecks();
    defineCheck("mcp-budget", async (t) => {
      await t.agent("rubric", { budget: { maxToolCalls: 1, maxTurns: 6 }, tools: { mcp: [factsServerConfig()] } });
    });
    const results = await runTraceChecks({
      snapshot,
      deliverables: { answer: "42" },
      judgeConfig: JUDGE,
    });
    const assertion = results[0]!.assertions[0]!;

    expect(assertion.pass).toBe(true);
    // Only the first MCP call entered the manifest; the second was refused.
    const mcpFingerprints = assertion.judge?.session?.evidence?.filter((e) => e.tool.startsWith("mcp__")) ?? [];
    expect(mcpFingerprints).toHaveLength(1);
    const refused = assertion.judge?.session?.steps
      ?.flatMap((s) => s.tool_calls ?? [])
      .filter((c) => c.name === "mcp__facts__get_fact");
    expect(refused?.[1]?.result).toContain("budget exhausted");
  });

  it("accounts read bytes for oversized MCP results and refuses past maxReadBytes", async () => {
    scriptFetch([
      toolCallTurn("1", "mcp__facts__big_fact", {}),
      toolCallTurn("2", "finish_verdict", { reasoning: "Big fact hit the read budget.", pass: false }),
    ]);

    resetFlowChecks();
    defineCheck("mcp-read-budget", async (t) => {
      await t.agent("rubric", { budget: { maxReadBytes: 1024, maxTurns: 4 }, tools: { mcp: [factsServerConfig()] } });
    });
    const results = await runTraceChecks({
      snapshot,
      deliverables: { answer: "42" },
      judgeConfig: JUDGE,
    });
    const assertion = results[0]!.assertions[0]!;

    expect(assertion.pass).toBe(false);
    const call = assertion.judge?.session?.steps
      ?.flatMap((s) => s.tool_calls ?? [])
      .find((c) => c.name === "mcp__facts__big_fact");
    expect(call?.result).toContain("read budget exhausted");
  });

  it("caps the result served to the model while fingerprinting the full payload", async () => {
    scriptFetch([
      toolCallTurn("1", "mcp__facts__big_fact", {}),
      toolCallTurn("2", "finish_verdict", { reasoning: "Served result was capped.", pass: true }),
    ]);

    const assertion = await runAgentCheck(async (t) => {
      await t.agent("PASS regardless.", { tools: { mcp: [factsServerConfig()] } });
    });

    // The manifest preserves the identity of the FULL ~200 KB result…
    const fingerprint = assertion.judge?.session?.evidence?.find((e) => e.tool === "mcp__facts__big_fact");
    expect(fingerprint?.result_bytes).toBeGreaterThan(200_000);
    // …while the recorded transcript step stays inside the §10 caps.
    const call = assertion.judge?.session?.steps
      ?.flatMap((s) => s.tool_calls ?? [])
      .find((c) => c.name === "mcp__facts__big_fact");
    expect((call?.result?.length ?? 0)).toBeLessThan(8_000);
  });

  it("times out a hung MCP tool and returns an error to the model", async () => {
    scriptFetch([
      toolCallTurn("1", "mcp__facts__slow_fact", {}),
      toolCallTurn("2", "finish_verdict", { reasoning: "Slow fact timed out; judged without it.", pass: true }),
    ]);

    const assertion = await runAgentCheck(async (t) => {
      await t.agent("PASS regardless.", {
        tools: { mcp: [factsServerConfig({ timeoutMs: 150 })] },
      });
    });

    expect(assertion.pass).toBe(true);
    const call = assertion.judge?.session?.steps
      ?.flatMap((s) => s.tool_calls ?? [])
      .find((c) => c.name === "mcp__facts__slow_fact");
    expect(call?.result).toContain("timed out");
  });

  it("fails closed (recorded failure naming the server) when the server cannot start", async () => {
    scriptFetch([toolCallTurn("x", "finish_verdict", { reasoning: "never reached", pass: true })]);

    const assertion = await runAgentCheck(async (t) => {
      await t.agent("PASS regardless.", {
        tools: {
          mcp: [factsServerConfig({ transport: { type: "stdio", command: "/nonexistent/mcp-binary" } })],
        },
      });
    });

    expect(assertion.pass).toBe(false);
    expect(assertion.reasoning).toContain("facts");
  });

  it("closes the client and terminates the spawned server process after the session", async () => {
    scriptFetch([
      toolCallTurn("1", "mcp__facts__get_fact", { topic: "cleanup" }),
      toolCallTurn("2", "finish_verdict", { reasoning: "Done.", pass: true }),
    ]);

    await runAgentCheck(async (t) => {
      await t.agent("PASS regardless.", { tools: { mcp: [factsServerConfig()] } });
    });

    const pid = Number(readFileSync(process.env.FACTS_PID_FILE!, "utf-8"));
    expect(Number.isInteger(pid)).toBe(true);
    // The client's close() must have terminated the child (SIGTERM → exit).
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("never records transport secrets (env values) anywhere in the session", async () => {
    process.env.SECRET_TOKEN = "sentinel-T0PS3CRET";
    scriptFetch([
      toolCallTurn("1", "mcp__facts__get_fact", { topic: "secrets" }),
      toolCallTurn("2", "finish_verdict", { reasoning: "Fact retrieved.", pass: true }),
    ]);

    const assertion = await runAgentCheck(async (t) => {
      await t.agent("PASS regardless.", {
        tools: {
          mcp: [
            factsServerConfig({
              transport: {
                type: "stdio",
                command: process.execPath,
                args: [FACTS_SERVER],
                env: { FACTS_PID_FILE: "${FACTS_PID_FILE}", SECRET_TOKEN: "${SECRET_TOKEN}" },
              },
            }),
          ],
        },
      });
    });

    expect(assertion.pass).toBe(true);
    expect(JSON.stringify(assertion.judge?.session ?? {})).not.toContain("sentinel-T0PS3CRET");
  });
});

// ── Entry surface and lazy isolation ────────────────────────────────────────

describe("t.agent MCP — entry surface and lazy isolation", () => {
  it("public entry re-exports the MCP config types", async () => {
    const pub = await import("../src/agent-task/public.ts");
    expect(pub).toBeTruthy();
    // Compile-time proof lives in the import below; runtime proves the graph
    // loads without the engine.
    const cfg: import("../src/agent-task/public.ts").McpServerConfig = {
      name: "x",
      transport: { type: "stdio", command: "x" },
    };
    expect(cfg.name).toBe("x");
  });

  it("importing the built entry never loads the engine or the MCP client (lazy isolation)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync: write } = await import("node:fs");
    const { tmpdir: t } = await import("node:os");
    const { join: j } = await import("node:path");

    const dir = mkdtempSync(j(t(), "mcp-isolation-"));
    const hook = j(dir, "forbid-engine.mjs");
    write(
      hook,
      `import { registerHooks } from "node:module";
       registerHooks({
         resolve(specifier, context, nextResolve) {
           if (
             specifier === "ai" ||
             specifier === "@ai-sdk/openai-compatible" ||
             specifier === "@ai-sdk/mcp" ||
             specifier === "@ai-sdk/mcp/mcp-stdio"
           ) {
             throw new Error(\`forbidden engine import: \${specifier}\`);
           }
           return nextResolve(specifier, context);
         },
       });`,
    );
    const entry = join(__dirname, "..", "dist", "agent-task", "public.js");
    const child = j(dir, "import-entry.mjs");
    write(child, `import(${JSON.stringify(entry)}).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });`);

    execFileSync(process.execPath, ["--import", hook, child], { stdio: "pipe" });
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
