/**
 * Claude Code replay-capture adapter — the "no OTel at all" counterpart of
 * `claude-adapter.ts`.
 *
 * Same agent (`agent/claude-agent.ts`), same lifecycle shape, one decisive
 * difference: the subprocess gets NO OTLP env, no TRACEPARENT — nothing. The
 * harness runs exactly as it would for a human, persisting its session JSONL
 * (`persistSession: true`). The adapter declares that transcript on the
 * session (`session.transcript`), and apo's runner replays it into the run's
 * live trace after the turn loop: generations, thinking, and tool calls land
 * in the same trace, typed and priced, and `t.calledTool` assertions read
 * them exactly like native-OTel spans.
 *
 * Why this matters: a harness that cannot emit OTel (Codex CLI, plain
 * Claude Code, most vendor CLIs) becomes an apo adapter with only lifecycle
 * plumbing — no instrumentation contract to satisfy. Run the same task under
 * `claude-agent` (native OTel) and this adapter to see the two capture paths
 * produce equivalent traces.
 */
import { join } from "path";
import { defineAdapter, type AdapterSession } from "@apo-ai/sdk/agent-task";
import { z } from "zod";
import { runClaudeAgent } from "./agent/claude-agent.ts";
import { findClaudeCodeTranscript } from "./lib/claude-transcript.ts";

type ClaudeSessionState = {
  turnCount: number;
  numTurns: number;
  lastResponse: string;
};

const EMPTY_STATE: ClaudeSessionState = { turnCount: 0, numTurns: 0, lastResponse: "" };

export const claudeCodeReplayAdapter = defineAdapter({
  name: "claude-code-replay",
  deliverables: {
    result: z.object({ summary: z.string() }).describe("Agent's final response."),
    stats: z.object({ turn_count: z.number(), num_turns: z.number() }).describe("Execution stats."),
  },

  turn: async ({ files, transcript }) => {
    if (transcript.length > 0) return null;
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
    const cwd = join(ctx.taskDir, "files");
    const state = (ctx.state ?? EMPTY_STATE) as ClaudeSessionState;
    const model = process.env.CLAUDE_MODEL;

    const session: AdapterSession = {
      runConfiguration: model ? { model } : undefined,
      async sendUserTurn(turn: unknown) {
        state.turnCount++;
        const { text, is_error, num_turns, session_id } = await runClaudeAgent({
          prompt: String(turn),
          cwd,
        // The whole point: the plain environment, no OTel plumbing. Strip
        // host telemetry config so the subprocess cannot emit a second,
        // native-OTel trace alongside the transcript the runner replays —
        // a host carrying OTEL_* or CLAUDE_CODE_*TELEMETRY* vars would
        // otherwise be double-captured.
        env: stripTelemetryEnv(process.env),
          persist: true,
        });

        state.numTurns = num_turns;
        state.lastResponse = is_error ? `Error: ${text}` : text;

        if (session_id !== undefined) {
          const transcriptPath = await findClaudeCodeTranscript(session_id);
          if (transcriptPath !== null) {
            session.transcript = { source: "claude-code", path: transcriptPath };
          }
        }
        return { response: state.lastResponse };
      },
    };
    return session;
  },

  async collectDeliverables(ctx) {
    const state = (ctx.state ?? EMPTY_STATE) as ClaudeSessionState;
    return {
      result: { summary: state.lastResponse || "Claude Code replay run completed" },
      stats: { turn_count: state.turnCount, num_turns: state.numTurns },
    };
  },
});

/**
 * Copy of the host environment minus every variable that would make the
 * Claude Code subprocess emit its own telemetry. CLAUDE_MODEL and ordinary
 * Claude credentials survive; only the OTel/tracing surface is removed, so
 * the session transcript stays the run's single trace source.
 */
function stripTelemetryEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("OTEL_") ||
      key === "TRACEPARENT" ||
      key === "TRACESTATE" ||
      key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      key.startsWith("CLAUDE_CODE_OTLP_")
    ) {
      delete env[key];
    }
  }
  return env;
}
