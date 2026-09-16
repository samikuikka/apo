import { describe, it, expect, vi, afterEach } from "vitest";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../src/agent-task/checks/flow-runner.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

/**
 * t.agent — the agentic judge. The engine (AI SDK) is exercised against a
 * scripted OpenAI-compatible endpoint: each fetch returns the next canned
 * tool-call turn, so the tests drive real multi-step sessions (evidence
 * reads → done-tool verdict) through the public check surface
 * (defineCheck + runTraceChecks), exactly the way an eval file reaches it.
 */

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
  observations: [
    {
      spanId: "s1", type: "TOOL", name: "read_file", status: "ok",
      startedAt: "2026-01-01T00:00:01.000Z", toolName: "read_file",
      toolParameters: { path: "a.txt" }, output: { lines: 1 },
    },
  ],
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

/** Scripts one response per request; extra requests repeat the last script. */
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

async function runAgentCheck(fn: Parameters<typeof defineCheck>[1]) {
  resetFlowChecks();
  defineCheck("agent-under-test", fn);
  const results = await runTraceChecks({
    snapshot,
    deliverables: { answer: "42", log: "step1\nstep2" },
    judgeConfig: JUDGE,
  });
  return results[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("t.agent — agentic judge sessions", () => {
  it("records a verdict from a done-tool session with transcript and manifest", async () => {
    scriptFetch([
      toolCallTurn("1", "read_deliverable", { name: "answer", offset: 0, limit: 6000 }),
      toolCallTurn("2", "finish_verdict", { reasoning: "The answer 42 is directly supported by the log.", pass: true }),
    ]);

    const result = await runAgentCheck(async (t) => {
      await t.agent("PASS if the answer matches the log.", { label: "agent-check" });
    });

    const assertion = result.assertions[0]!;
    expect(assertion.evaluator_type).toBe("agent");
    expect(assertion.pass).toBe(true);
    expect(assertion.reasoning).toContain("42");
    expect(assertion.expected).toBe("PASS if the answer matches the log.");

    const session = assertion.judge?.session;
    expect(session?.outcome).toBe("verdict");
    expect(session?.steps?.length).toBe(2);
    // The evidence read is fingerprinted: 64-char sha256 + byte size.
    const fingerprint = session?.evidence?.[0];
    expect(fingerprint?.tool).toBe("read_deliverable");
    expect(fingerprint?.result_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint?.result_bytes).toBeGreaterThan(0);
    expect(session?.usage?.input_tokens).toBe(240);
  });

  it("fail-closes when the model never verdicts (budget exhausted)", async () => {
    scriptFetch([toolCallTurn("loop", "read_deliverable", { name: "log", offset: 0, limit: 100 })]);

    const result = await runAgentCheck(async (t) => {
      await t.agent("never satisfied", { budget: { maxTurns: 3, timeoutMs: 30_000 } });
    });

    const assertion = result.assertions[0]!;
    expect(assertion.pass).toBe(false);
    expect(assertion.reasoning).toContain("without a verdict");
    expect(assertion.judge?.session?.outcome).toBe("budget_exhausted");
    expect(assertion.judge?.session?.steps?.length).toBeLessThanOrEqual(3);
  });

  it("fail-closes on malformed verdict args", async () => {
    scriptFetch([
      toolCallTurn("1", "finish_verdict", { reasoning: "hasty", pass: "yes" }),
    ]);

    const result = await runAgentCheck(async (t) => {
      await t.agent("anything");
    });

    const assertion = result.assertions[0]!;
    expect(assertion.pass).toBe(false);
    // Either the engine rejects the malformed call (error) or no valid
    // verdict is extracted (budget) — both must land as recorded failures.
    expect(assertion.pass).toBe(false);
    expect(assertion.judge?.session?.outcome).not.toBe("verdict");
  });

  it("records env guidance without touching the network when no judge is configured", async () => {
    const fetchMock = scriptFetch([toolCallTurn("x", "finish_verdict", { reasoning: "r", pass: true })]);

    resetFlowChecks();
    defineCheck("no-config", async (t) => {
      await t.agent("rubric");
    });
    const results = await runTraceChecks({ snapshot, deliverables: {} });

    const assertion = results[0]!.assertions[0]!;
    expect(assertion.pass).toBe(false);
    expect(assertion.reasoning).toContain("No judge model configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers the trace tool with capability honesty and records exhibits as received", async () => {
    scriptFetch([
      toolCallTurn("1", "get_trace", { query: "" }),
      toolCallTurn("2", "finish_verdict", { reasoning: "Trace shows read_file; exhibit matches.", pass: true }),
    ]);

    const result = await runAgentCheck(async (t) => {
      await t.agent("consistent?", { exhibits: "42" });
    });

    const assertion = result.assertions[0]!;
    expect(assertion.pass).toBe(true);
    expect(assertion.received).toBe("42");
    expect(assertion.judge?.session?.tools).toContain("get_trace");
    expect(assertion.judge?.session?.tools).toContain("finish_verdict");
  });
});

describe("t.agent — budget accounting", () => {
  it("stops accounting tool calls once maxToolCalls trips; verdict still lands", async () => {
    scriptFetch([
      toolCallTurn("1", "read_deliverable", { name: "log", offset: 0, limit: 100 }),
      toolCallTurn("2", "read_deliverable", { name: "log", offset: 0, limit: 100 }),
      toolCallTurn("3", "read_deliverable", { name: "log", offset: 0, limit: 100 }),
      toolCallTurn("4", "finish_verdict", { reasoning: "Enough evidence.", pass: true }),
    ]);

    const result = await runAgentCheckWithBudget({ maxToolCalls: 2, maxTurns: 6 });

    const assertion = result.assertions[0]!;
    expect(assertion.pass).toBe(true);
    // Only the two unguarded reads entered the manifest; the guarded third
    // read returned an error before accounting.
    expect(assertion.judge?.session?.evidence?.length).toBe(2);
  });

  it("accounts read bytes and refuses to serve past maxReadBytes", async () => {
    scriptFetch([
      toolCallTurn("1", "read_deliverable", { name: "log", offset: 0, limit: 6000 }),
      toolCallTurn("2", "finish_verdict", { reasoning: "Budget hit.", pass: false }),
    ]);

    const result = await runAgentCheckWithBudget({ maxReadBytes: 5, maxTurns: 4 });

    const assertion = result.assertions[0]!;
    expect(assertion.pass).toBe(false);
    // The oversized read WAS accounted (manifest carries it) before the
    // overflow error was returned to the model.
    expect(assertion.judge?.session?.evidence?.length).toBe(1);
  });

  it("search_deliverable rejects invalid regex without ending the session", async () => {
    scriptFetch([
      toolCallTurn("1", "search_deliverable", { name: "log", pattern: "([unclosed" }),
      toolCallTurn("2", "finish_verdict", { reasoning: "Search failed; judged on read.", pass: true }),
    ]);

    const result = await runAgentCheck(async (t) => {
      await t.agent("search rubric");
    });

    const assertion = result.assertions[0]!;
    expect(assertion.pass).toBe(true);
    expect(assertion.judge?.session?.evidence?.length).toBe(0);
  });

  async function runAgentCheckWithBudget(budget: { maxTurns?: number; maxToolCalls?: number; maxReadBytes?: number }) {
    resetFlowChecks();
    defineCheck("agent-budget", async (t) => {
      await t.agent("budget rubric", { budget });
    });
    const results = await runTraceChecks({
      snapshot,
      deliverables: { answer: "42", log: "step1\nstep2".repeat(50) },
      judgeConfig: JUDGE,
    });
    return results[0]!;
  }
});

describe("t.agent — module isolation and entry surface", () => {
  it("TEST_METHOD_NAMES registers agent alongside judge", async () => {
    const { TEST_METHOD_NAMES } = await import("../src/agent-task/checks/t.ts");
    expect(TEST_METHOD_NAMES).toContain("agent");
    expect(TEST_METHOD_NAMES).toContain("judge");
  });

  it("public entry re-exports the agent-judge surface", async () => {
    // Type-only import compiles = the surface is exported; the value import
    // proves the module graph loads without the engine.
    const pub = await import("../src/agent-task/public.ts");
    expect(pub.TEST_METHOD_NAMES).toContain("agent");
  });

  it("importing the built entry never loads the ai engine (lazy isolation)", async () => {
    // Spawn a child node with a resolve hook that forbids `ai` and the
    // provider package, then import the BUILT package entry. If anything in
    // the module graph pulled the engine at load time, the child exits 1.
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "agent-isolation-"));
    const hook = join(dir, "forbid-ai.mjs");
    writeFileSync(
      hook,
      `import { registerHooks } from "node:module";
       registerHooks({
         resolve(specifier, context, nextResolve) {
           if (specifier === "ai" || specifier === "@ai-sdk/openai-compatible") {
             throw new Error(\`forbidden engine import: \${specifier}\`);
           }
           return nextResolve(specifier, context);
         },
       });`,
    );
    const entry = join(__dirname, "..", "dist", "agent-task", "public.js");
    const child = join(dir, "import-entry.mjs");
    writeFileSync(child, `import(${JSON.stringify(entry)}).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });`);

    execFileSync(process.execPath, ["--import", hook, child], { stdio: "pipe" });
  }, 30_000);
});
