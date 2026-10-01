/**
 * Transcript-replay adapter capture — the runner integration.
 *
 * An adapter declares `session.transcript`; `runTask` replays it after the
 * turn loop. These tests prove the full loop through the real entry point:
 *
 * - offline runs: replayed observations join the local snapshot, so
 *   `t.calledTool` passes with no backend and no OTel anywhere;
 * - traced runs: the OTLP payload joins the LIVE trace (same trace id,
 *   interactions parented under the run root) and exports with the run's
 *   credentials;
 * - recorded runs: the canonical read-back waits until the projection has
 *   absorbed the replayed observations before Phase 2 evaluates;
 * - contract: a declared-but-missing transcript fails the run loudly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basename, join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";

import { runTask } from "../src/agent-task/run/runTask";

const TMP_ROOT = join(import.meta.dirname, "__transcript_replay_capture_test__");
// Fresh dir per test: import() caches by path, so rewriting the eval in the
// same dir would silently re-run the previous test's module.
let taskDir = "";
const LOCAL_DEFINE_TASK_IMPORT = "../../../src/agent-task/task/defineTask";
const LOCAL_DEFINE_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";

const FAKE_TRACE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const FAKE_ROOT_SPAN_ID = "1111111111111111";

// A minimal but real Claude-Code-format session: one turn, thinking + a Read
// tool call with its result, streamed final text sharing message.id "m1".
const TRANSCRIPT_FIXTURE = [
  JSON.stringify({
    type: "user",
    sessionId: "replay-sess-1",
    cwd: "/tmp/replay",
    timestamp: "2026-10-01T12:00:00Z",
    message: { role: "user", content: "Read the invoice and report the total." },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T12:00:05Z",
    message: {
      id: "m1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: "thinking", thinking: "Reading first." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "invoice.txt" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-10-01T12:00:06Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "Total: 100 EUR" }],
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T12:00:10Z",
    message: {
      id: "m1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 20 },
      content: [{ type: "text", text: "The total is 100 EUR." }],
    },
  }),
].join("\n");

/** Fake trace client: fixed ids, records step names, delegates nothing. */
const recordedSteps: string[] = [];
const traceRun = vi.fn(async (_params: unknown, fn: (trace: object) => Promise<unknown>) =>
  fn({
    runId: FAKE_TRACE_ID,
    rootSpanId: FAKE_ROOT_SPAN_ID,
    async step(options: { step_name?: string }, stepFn: (spanId: string) => Promise<unknown>) {
      recordedSteps.push(options.step_name ?? "?");
      return stepFn(`span-${recordedSteps.length}`);
    },
    recordEvent() {
      return "event-1";
    },
    endRoot() {},
    traceTool<T>(_name: string, _params: Record<string, unknown>, fn: () => Promise<T>) {
      return fn();
    },
  }),
);

function writeTask(options: { missingTranscript?: boolean; checks: string }): void {
  writeFileSync(
    join(taskDir, "adapter.ts"),
    `
import { writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";

export const TRANSCRIPT_FIXTURE = ${JSON.stringify(TRANSCRIPT_FIXTURE)};

export const testAdapter = defineAdapter({
  name: "replay-adapter",
  deliverables: { summary: z.object({ text: z.string() }) },
  turn: async ({ transcript }) => (transcript.length > 0 ? null : "Please read the invoice."),
  async startSession(ctx) {
    const transcriptPath = join(ctx.taskDir, "harness-session.jsonl");
    ${
      options.missingTranscript
        ? '// declares a transcript that never exists — the run must fail loudly'
        : 'writeFileSync(transcriptPath, TRANSCRIPT_FIXTURE, "utf-8");'
    }
    return {
      transcript: { source: "claude-code", path: transcriptPath },
      async sendUserTurn() {
        return { response: "done" };
      },
    };
  },
  async collectDeliverables() {
    return { summary: { text: "done" } };
  },
});
`,
  );
  writeFileSync(
    join(taskDir, `${basename(taskDir)}.eval.ts`),
    `
import { task } from "${LOCAL_DEFINE_TASK_IMPORT}";
import { testAdapter } from "./adapter";

const { test } = task("replay-capture-task", {
  adapter: testAdapter,
  description: "Transcript-replay capture integration task.",
  deliverables: ["summary"],
});

${options.checks}
`,
  );
}

const REPLAY_CHECKS = `
test("called-read", (t) => { t.calledTool("Read"); });
test("called-read-args", (t) => { t.calledTool("Read", { input: { file_path: "invoice.txt" } }); });
test("no-failed-actions", (t) => { t.noFailedActions(); });
`;

beforeEach(() => {
  recordedSteps.length = 0;
  traceRun.mockClear();
  rmSync(TMP_ROOT, { recursive: true, force: true });
  taskDir = join(TMP_ROOT, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(taskDir, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_TASK_TRACE_ENDPOINT;
  delete process.env.APO_AUTH_TOKEN;
});

describe("transcript-replay adapter capture", () => {
  it("replays into the local snapshot on an untraced run — checks pass with no backend", async () => {
    writeTask({ checks: REPLAY_CHECKS });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no network call expected on an untraced run");
      }),
    );

    const result = await runTask(taskDir);
    expect(result.result.pass).toBe(true);
    expect(result.result.checks.map((r) => r.id).sort()).toEqual([
      "called-read",
      "called-read-args",
      "no-failed-actions",
    ]);
  });

  it("replays into the local snapshot on a traced offline run and records the replay step", async () => {
    writeTask({ checks: REPLAY_CHECKS });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no network call expected without export credentials");
      }),
    );

    const result = await runTask(taskDir, {
      tracing: { client: { traceRun }, project: "demo" },
    });
    expect(result.result.pass).toBe(true);
    expect(result.traceRunId).toBe(FAKE_TRACE_ID);
    expect(recordedSteps).toContain("adapter.replay-transcript");
  });

  it("exports the replay into the live trace with the run's credentials", async () => {
    writeTask({ checks: REPLAY_CHECKS });
    process.env.AGENT_TASK_TRACE_ENDPOINT = "http://apo.test";
    process.env.APO_AUTH_TOKEN = "attempt-token";

    const posts: Array<{ url: string; body: unknown; auth: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (typeof url === "string" && url.endsWith("/api/public/otel/v1/traces")) {
          posts.push({
            url,
            body: JSON.parse(String(init?.body)) as unknown,
            auth: new Headers(init?.headers).get("Authorization"),
          });
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${String(url)}`);
      }),
    );

    const result = await runTask(taskDir, {
      tracing: { client: { traceRun }, project: "demo" },
    });
    expect(result.result.pass).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.auth).toBe("Bearer attempt-token");

    const payload = posts[0]!.body as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    };
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.length).toBe(4); // interaction + llm_request + thinking + tool
    for (const span of spans) {
      expect(span.traceId).toBe(FAKE_TRACE_ID);
    }
    const interactions = spans.filter((s) => s.name === "claude_code.interaction");
    expect(interactions).toHaveLength(1);
    expect(interactions[0]!.parentSpanId).toBe(FAKE_ROOT_SPAN_ID);
    // Joining a live trace: the run root already carries run metadata.
    expect(JSON.stringify(spans)).not.toContain("apo.run.flow_name");
  });

  it("waits for the canonical projection to absorb the replayed observations before evaluating", async () => {
    writeTask({
      checks: `
test("called-read", (t) => { t.calledTool("Read"); });
test("canonical-evidence", (t) => { t.calledTool("CanonicalOnly"); });
`,
    });
    process.env.AGENT_TASK_TRACE_ENDPOINT = "http://apo.test";
    process.env.APO_AUTH_TOKEN = "attempt-token";

    const observation = (over: Record<string, unknown>) => ({
      spanId: Math.random().toString(16).slice(2, 18),
      type: "SPAN",
      name: "step",
      status: "ok",
      startedAt: "2026-10-01T12:00:00Z",
      ...over,
    });
    const snapshotWith = (observations: unknown[]) => ({
      schemaVersion: 1,
      projectionVersion: 1,
      source: "canonical",
      trace: { traceId: FAKE_TRACE_ID, complete: true },
      capabilities: {
        messages: "available",
        tools: "available",
        errors: "available",
        timing: "available",
        skills: "unavailable",
        subagents: "unavailable",
        usage: "available",
      },
      observations,
    });

    let projectionReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (typeof url === "string" && url.endsWith("/api/public/otel/v1/traces")) {
          return new Response(null, { status: 200 });
        }
        if (typeof url === "string" && url.includes("/trace-projection")) {
          projectionReads += 1;
          // First read: the trace exists but the replay batch has not been
          // projected yet (far below the observation floor). Second read: the
          // full projection, including evidence only the backend has.
          if (projectionReads === 1) {
            return Response.json(
              snapshotWith([observation({ type: "TOOL", toolName: "CanonicalOnly" })]),
            );
          }
          return Response.json(
            snapshotWith([
              ...Array.from({ length: 12 }, () => observation({})),
              observation({ type: "TOOL", toolName: "Read" }),
              observation({ type: "TOOL", toolName: "CanonicalOnly" }),
            ]),
          );
        }
        throw new Error(`unexpected fetch: ${String(url)} ${String(init?.method)}`);
      }),
    );

    const result = await runTask(taskDir, {
      tracing: { client: { traceRun }, project: "demo", taskRunId: "task-run-1" },
    });
    // The thin first snapshot lacks the replayed Read observation, so the
    // read-back must have polled again before Phase 2 evaluated.
    expect(projectionReads).toBeGreaterThanOrEqual(2);
    expect(result.result.pass).toBe(true);
  });

  it("fails the run loudly when a declared transcript is missing", async () => {
    writeTask({ missingTranscript: true, checks: REPLAY_CHECKS });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no network call expected");
      }),
    );

    await expect(runTask(taskDir)).rejects.toMatchObject({
      message: expect.stringContaining("Transcript capture failed"),
    });
  });
});
