/**
 * Live transcript-replay smoke — OPT-IN (TRANSCRIPT_REPLAY_SMOKE=1).
 *
 * Skipped in CI: it needs a real apo backend. Proves the full recorded-run
 * loop with a REAL OTel trace client — not a fake one:
 *
 *   runner spans export over OTLP (API-key Basic auth) → adapter declares its
 *   transcript → the runner replays it INTO THE SAME LIVE TRACE → checks pass
 *   off the merged evidence.
 *
 * Start a backend and mint a key first, e.g.:
 *
 *   DATABASE_URL=sqlite:////tmp/smoke.db AUTH_SECRET=dev uv run uvicorn main:app --port 8907
 *   # then create a pk/sk API key for project "demo" and export:
 *   TRANSCRIPT_REPLAY_SMOKE=1 \
 *   AGENT_TASK_TRACE_ENDPOINT=http://localhost:8907 \
 *   AGENT_TASK_PROJECT=demo \
 *   APO_PUBLIC_KEY=pk-apo-… APO_SECRET_KEY=sk-apo-… \
 *   pnpm --filter @apo-ai/sdk test transcript-replay-live-smoke
 */
import { describe, expect, it } from "vitest";
import { basename, join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";

import { runTaskDir } from "../src/agent-task/public.ts";

const SMOKE = process.env.TRANSCRIPT_REPLAY_SMOKE === "1";
const TMP_ROOT = join(import.meta.dirname, "__transcript_live_smoke__");
const LOCAL_DEFINE_TASK_IMPORT = "../../../src/agent-task/task/defineTask";
const LOCAL_DEFINE_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";

// One real-format Claude Code turn: Read tool call + result + final answer.
const TRANSCRIPT_FIXTURE = [
  JSON.stringify({
    type: "user",
    sessionId: "live-smoke-sess-1",
    cwd: "/tmp/live-smoke",
    timestamp: "2026-10-01T15:00:00Z",
    message: { role: "user", content: "Read the invoice and report the total." },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T15:00:05Z",
    message: {
      id: "m1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "invoice.txt" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-10-01T15:00:06Z",
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
    timestamp: "2026-10-01T15:00:10Z",
    message: {
      id: "m1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 150, output_tokens: 20, cache_read_input_tokens: 60 },
      content: [{ type: "text", text: "The total is 100 EUR." }],
    },
  }),
].join("\n");

describe("transcript-replay live smoke (real OTel client + backend)", () => {
  it.skipIf(!SMOKE)("runs a task whose only trace source is a replayed transcript", async () => {
    expect(process.env.AGENT_TASK_TRACE_ENDPOINT).toBeDefined();
    expect(process.env.AGENT_TASK_PROJECT).toBeDefined();

    const taskDir = join(TMP_ROOT, `live-${Date.now()}`);
    mkdirSync(taskDir, { recursive: true });
    try {
      writeFileSync(
        join(taskDir, "adapter.ts"),
        `
import { writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";

export const testAdapter = defineAdapter({
  name: "live-replay-adapter",
  deliverables: { summary: z.object({ text: z.string() }) },
  turn: async ({ transcript }) => (transcript.length > 0 ? null : "Please read the invoice."),
  async startSession(ctx) {
    const transcriptPath = join(ctx.taskDir, "harness-session.jsonl");
    writeFileSync(transcriptPath, ${JSON.stringify(TRANSCRIPT_FIXTURE)}, "utf-8");
    return {
      transcript: { source: "claude-code", path: transcriptPath },
      async sendUserTurn() {
        return { response: "The total is 100 EUR." };
      },
    };
  },
  async collectDeliverables() {
    return { summary: { text: "The total is 100 EUR." } };
  },
});
`,
      );
      writeFileSync(
        join(taskDir, `${basename(taskDir)}.eval.ts`),
        `
import { task } from "${LOCAL_DEFINE_TASK_IMPORT}";
import { testAdapter } from "./adapter";

const { test } = task("live-replay-task", {
  adapter: testAdapter,
  description: "Live transcript-replay smoke.",
  deliverables: ["summary"],
});

test("called-read", (t) => { t.calledTool("Read"); });
test("no-failed-actions", (t) => { t.noFailedActions(); });
`,
      );

      const summary = await runTaskDir(taskDir);
      // Printed for the operator; the DB assertions live outside this test.
      console.log("[live-smoke] traceRunId:", summary.traceRunId);
      expect(summary.pass).toBe(true);
      expect(summary.traceRunId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  });
});
