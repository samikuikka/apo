import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createBackendReaderFromEnv,
  freezeHistoryPlane,
  freezeHistoryPlaneFromEnv,
  type BackendReader,
  type FrozenRunSummary,
} from "../src/agent-task/checks/agent-history.ts";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../src/agent-task/checks/flow-runner.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

/**
 * The history plane: read-only prior-run access for `t.agent`, frozen at
 * evaluation start, served over the executor's existing credentials. Reader
 * tests mock fetch at the HTTP boundary; the engine test scripts the LLM and
 * injects a real plane, proving list_runs/get_run ride the session like any
 * other evidence tool.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubEnv(env: Record<string, string | undefined>): void {
  const original = { ...process.env };
  for (const key of ["APO_AUTH_TOKEN", "APO_PUBLIC_KEY", "APO_SECRET_KEY", "AGENT_TASK_TRACE_ENDPOINT", "AGENT_TASK_RUN_ID"]) {
    delete process.env[key];
    if (env[key] !== undefined) process.env[key] = env[key]!;
  }
  afterEach(() => {
    process.env = original;
  });
}

const SUMMARY = (id: string, over: Partial<FrozenRunSummary> = {}): Record<string, unknown> => ({
  id,
  status: "failed",
  pass_result: false,
  started_at: "2026-09-16T10:00:00Z",
  primary_model: "test-model",
  passed_checks: 2,
  failed_checks: 1,
  ...over,
});

describe("BackendReader — credential resolution", () => {
  it("uses Bearer for APO_AUTH_TOKEN and joins the /v1 prefix", async () => {
    stubEnv({ APO_AUTH_TOKEN: "tok", AGENT_TASK_TRACE_ENDPOINT: "http://x:9/" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://x:9/v1/agent-task-runs");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const reader = createBackendReaderFromEnv();
    expect(reader).toBeDefined();
    await reader!.get("/agent-task-runs");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses Basic for the key pair; undefined with no credentials", () => {
    stubEnv({ APO_PUBLIC_KEY: "pk", APO_SECRET_KEY: "sk" });
    expect(createBackendReaderFromEnv()).toBeDefined();

    stubEnv({});
    expect(createBackendReaderFromEnv()).toBeUndefined();
  });
});

describe("freezeHistoryPlane — frozen snapshot + merged detail", () => {
  const readerFor = (list: unknown[], detail: Record<string, unknown> | null) => {
    const calls: string[] = [];
    const reader: BackendReader = {
      async get(path: string) {
        calls.push(path);
        if (path.startsWith("/agent-task-runs?")) return list;
        if (path.startsWith("/agent-task-runs/run_")) return detail;
        throw new Error(`unexpected path ${path}`);
      },
    };
    return { reader, calls };
  };

  it("fetches the list once; later runs appearing do not enter the snapshot", async () => {
    let list: unknown[] = [SUMMARY("run_a")];
    const { reader, calls } = readerFor(list, null);
    const plane = await freezeHistoryPlane({ reader, taskId: "t1" });

    expect(plane.runs.map((r) => r.id)).toEqual(["run_a"]);
    expect(calls.filter((c) => c.startsWith("/agent-task-runs?"))).toHaveLength(1);

    // The backend "grows" after the freeze; the plane must not notice.
    list = [SUMMARY("run_a"), SUMMARY("run_b")];
    expect(plane.runs).toHaveLength(1);
  });

  it("merges checks + corrections in one get_run and caches the detail", async () => {
    const list = [SUMMARY("run_a", { corrected_tests: [{ test: "t", from: false, to: true }] })];
    const detail = {
      status: "failed",
      checks_json: JSON.stringify([
        {
          id: "answer-matches-benchmark",
          pass: false,
          evaluator_type: "code",
          reasoning: "expected E:13.57",
          assertions: [{ pass: false, expected: "E:13.57", received: "All:39.17" }],
        },
      ]),
    };
    const { reader, calls } = readerFor(list, detail);
    const plane = await freezeHistoryPlane({ reader, taskId: "t1" });

    const first = await plane.getRun("run_a");
    expect(first).not.toHaveProperty("error");
    const run = first as Exclude<typeof first, { error: string }>;
    expect(run.checks[0]!.id).toBe("answer-matches-benchmark");
    expect(run.checks[0]!.assertions![0]!.received).toBe("All:39.17");
    expect(run.human_corrections).toEqual([{ test: "t", from: false, to: true }]);

    await plane.getRun("run_a");
    expect(calls.filter((c) => c.startsWith("/agent-task-runs/run_"))).toHaveLength(1);
  });

  it("answers the run under judgment and unknown ids honestly", async () => {
    const { reader } = readerFor([SUMMARY("run_self")], null);
    const plane = await freezeHistoryPlane({ reader, taskId: "t1", selfRunId: "run_self" });

    const self = await plane.getRun("run_self");
    expect((self as { error: string }).error).toContain("run under judgment");

    const unknown = await plane.getRun("run_ghost");
    expect((unknown as { error: string }).error).toContain("not in this task's history");

    expect(plane.runs[0]!.is_run_under_judgment).toBe(true);
  });

  it("human_corrections reads 'none' when a run has no corrections", async () => {
    const { reader } = readerFor([SUMMARY("run_a")], { status: "passed", checks_json: "[]" });
    const plane = await freezeHistoryPlane({ reader, taskId: "t1" });
    const run = (await plane.getRun("run_a")) as { human_corrections: unknown };
    expect(run.human_corrections).toBe("none");
  });
});

describe("freezeHistoryPlaneFromEnv — degradation", () => {
  it("returns undefined without credentials", async () => {
    stubEnv({});
    expect(await freezeHistoryPlaneFromEnv("t1")).toBeUndefined();
  });

  it("returns undefined when the list fetch fails — a history outage never fails evaluation", async () => {
    stubEnv({ APO_AUTH_TOKEN: "tok" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await freezeHistoryPlaneFromEnv("t1")).toBeUndefined();
  });
});

describe("t.agent sessions over the history plane", () => {
  const snapshot: TraceProjectionSnapshot = {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "local",
    trace: { traceId: "t", complete: true },
    capabilities: {
      messages: "available", tools: "available", errors: "available",
      timing: "available", skills: "available", subagents: "unavailable",
    },
    observations: [],
  };

  function toolCallTurn(id: string, name: string, args: unknown) {
    return {
      id: `chatcmpl-${id}`, object: "chat.completion", created: 0, model: "test-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    };
  }

  function scriptFetch(responses: unknown[]) {
    let call = 0;
    vi.fn();
    const mock = vi.fn(async () => {
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return jsonResponse(body);
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("list_runs and get_run ride the session and enter the evidence manifest", async () => {
    const plane = await freezeHistoryPlane({
      reader: {
        async get(path: string) {
          if (path.startsWith("/agent-task-runs?")) return [SUMMARY("run_prior"), SUMMARY("run_self")];
          if (path.includes("run_prior")) {
            return {
              status: "failed",
              checks_json: JSON.stringify([{ id: "bench", pass: false, evaluator_type: "code" }]),
            };
          }
          throw new Error(`unexpected ${path}`);
        },
      },
      taskId: "t1",
      selfRunId: "run_self",
    });

    scriptFetch([
      toolCallTurn("1", "list_runs", {}),
      toolCallTurn("2", "get_run", { run_id: "run_prior" }),
      toolCallTurn("3", "finish_verdict", { reasoning: "Prior attempt failed the same benchmark check.", pass: false }),
    ]);

    resetFlowChecks();
    defineCheck("agent-history", async (t) => {
      await t.agent("does the failure recur?");
    });
    const results = await runTraceChecks({
      snapshot,
      deliverables: { answer: "42" },
      judgeConfig: { model: "test-model", apiKey: "k" },
      historyPlane: plane,
    });

    const assertion = results[0]!.assertions[0]!;
    expect(assertion.pass).toBe(false);
    expect(assertion.judge?.session?.tools).toContain("list_runs");
    expect(assertion.judge?.session?.tools).toContain("get_run");
    // get_run is accounted evidence; list_runs summaries are tool metadata.
    const fingerprint = assertion.judge?.session?.evidence?.find((e) => e.tool === "get_run");
    expect(fingerprint?.result_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("without a plane the tools are absent and the briefing says so honestly", async () => {
    scriptFetch([
      toolCallTurn("1", "read_deliverable", { name: "answer", offset: 0, limit: 100 }),
      toolCallTurn("2", "finish_verdict", { reasoning: "Judged on the deliverable alone.", pass: true }),
    ]);

    resetFlowChecks();
    defineCheck("agent-no-history", async (t) => {
      await t.agent("rubric");
    });
    const results = await runTraceChecks({
      snapshot,
      deliverables: { answer: "42" },
      judgeConfig: { model: "test-model", apiKey: "k" },
    });

    const assertion = results[0]!.assertions[0]!;
    expect(assertion.judge?.session?.tools).not.toContain("list_runs");
    expect(assertion.judge?.session?.briefing?.system).toContain("unavailable");
  });
});
