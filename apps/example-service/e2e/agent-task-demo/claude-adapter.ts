/**
 * Claude Agent SDK adapter — the "native OpenTelemetry" reference pattern.
 *
 * This adapter is deliberately thin. It owns ONLY the apo lifecycle wiring.
 * The actual agent (prompt, tools, model, the `query()` call) lives in
 * `./agent/claude-agent.ts` — that file is plain "user code" that could run
 * standalone, with zero knowledge of apo.
 *
 * Contrast with `ai-sdk-adapter.ts` / `real-agent-adapter.ts`, which embed the
 * agent loop, tools, and system prompt inside the adapter itself. This adapter
 * demonstrates the target pattern: adapter = plumbing, agent = your code.
 *
 * Tracing path (native OTel — no custom wrapper):
 *
 *   The Claude Agent SDK emits OpenTelemetry natively. It reads three standard
 *   OTLP env vars to decide where to export its spans, plus a W3C `TRACEPARENT`
 *   env var to link its spans under the active span's trace. The adapter sets
 *   all four on the subprocess env (see `lib/otel-env.ts`):
 *
 *     OTEL_EXPORTER_OTLP_ENDPOINT  → apo backend (/api/public/otel)
 *     OTEL_EXPORTER_OTLP_HEADERS   → Authorization: Bearer <APO_AUTH_TOKEN>
 *     OTEL_SERVICE_NAME            → "apo-claude-agent"
 *     TRACEPARENT                  → W3C traceparent from apo's active span
 *                                    (via `injectTraceparent()`)
 *
 *   Result: the SDK's LLM-generation and tool-call spans land in the SAME apo
 *   trace as the run, nested under the active `task.turn` span. No
 *   `registerApoTracing()`, no `createApoAnthropic` — pure native OTel.
 *
 *   One caveat: because the SDK runs in a subprocess, its spans export over
 *   OTLP to the backend (visible in the apo UI) but do NOT pass through apo's
 *   in-process trace projection — the surface eval assertions like
 *   `t.calledTool(...)` read. To keep assertions meaningful, `sendUserTurn`
 *   mirrors each tool call the SDK reported (from its stream) into the
 *   projection as a TOOL span. The SDK stream remains the source of truth;
 *   this just bridges subprocess activity into the local assertion surface.
 */
import { join } from "path";
import { defineAdapter } from "@apo/sdk/agent-task";
import { z } from "zod";
import { runClaudeAgent } from "./agent/claude-agent.ts";
import { buildOtelEnv } from "./lib/otel-env.ts";

/** State accumulated across turns in one session, surfaced to collectDeliverables. */
type ClaudeSessionState = {
  turnCount: number;
  numTurns: number;
  lastResponse: string;
};

const EMPTY_STATE: ClaudeSessionState = { turnCount: 0, numTurns: 0, lastResponse: "" };

export const claudeAdapter = defineAdapter({
  name: "claude-agent",
  deliverables: {
    result: z.object({ summary: z.string() }).describe("Agent's final response."),
    stats: z.object({ turn_count: z.number(), num_turns: z.number() }).describe("Execution stats."),
  },

  turn: async ({ files, transcript }) => {
    if (transcript.length > 0) return null;
    // The instructions.md file (if present) seeds the first user turn. The
    // agent reads it as an ordinary prompt — the adapter doesn't parse it.
    try {
      return await files.read("instructions.md");
    } catch {
      return "Extract all structured data from the source files in this directory.";
    }
  },

  async initialize() {
    return { ...EMPTY_STATE } satisfies ClaudeSessionState;
  },

  async startSession(ctx) {
    // The agent operates inside the task's files/ directory. Its built-in
    // Read/Grep/Bash tools work against real files there — no in-memory
    // fileContents map, no custom tool dispatch. This is the SDK's native model.
    const cwd = join(ctx.taskDir, "files");
    const state = (ctx.state ?? EMPTY_STATE) as ClaudeSessionState;

    return {
      async sendUserTurn(turn: unknown, { trace, parentSpanId }) {
        state.turnCount++;
        const { text, is_error, num_turns, tool_calls } = await runClaudeAgent({
          prompt: String(turn),
          cwd,
          env: buildOtelEnv(),
          model: process.env.CLAUDE_MODEL,
        });

        // The SDK runs in a separate subprocess. Its OTel spans export
        // natively to the backend over OTLP (visible in the apo UI), but they
        // do NOT pass through apo's in-process trace projection — the surface
        // that `t.calledTool(...)` reads. To keep assertions meaningful, mirror
        // each tool call the SDK reported into the projection as a TOOL span.
        // This is the same thing the in-process wrappers do (see span-helpers);
        // here the SDK stream is the source of truth instead of a Proxy.
        for (const call of tool_calls) {
          const spanId = trace.createSpan({
            task_id: "trace",
            parent_call_id: parentSpanId ?? trace.rootSpanId,
            step_name: call.name,
            observation_type: "TOOL",
            input:
              call.input && typeof call.input === "object"
                ? (call.input as Record<string, unknown>)
                : { value: call.input },
            metadata: { toolName: call.name, source: "claude-agent-sdk" },
          });
          trace.endSpan(spanId, {});
        }

        state.numTurns = num_turns;
        state.lastResponse = is_error ? `Error: ${text}` : text;
        return { response: state.lastResponse };
      },
    };
  },

  async collectDeliverables(ctx) {
    const state = (ctx.state ?? EMPTY_STATE) as ClaudeSessionState;
    // The full response IS the deliverable — don't truncate it. The eval's
    // fact checks and judges need the complete extraction (a 500-char slice
    // cuts off the monetary fields that appear later in the response). The
    // rich trace data lives separately in the spans (visible in the apo UI).
    return {
      result: { summary: state.lastResponse || "Claude Agent SDK run completed" },
      stats: { turn_count: state.turnCount, num_turns: state.numTurns },
    };
  },
});
