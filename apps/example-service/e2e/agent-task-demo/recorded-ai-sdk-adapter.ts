/**
 * Recorded-session adapter: one live run, replayed forever, keylessly.
 *
 * Record mode (explicit): with `APO_RECORD_FIXTURE=<path>` set, this is the
 * live AI SDK agent (`runSteerableChat` really calls the model, telemetry
 * flows natively), and the session (per-turn reply, every tool call with
 * input and result, the final deliverables) is frozen to that path as a
 * fixture when deliverables are collected.
 *
 * Replay mode (the default): no model, no network, no API keys. Each turn
 * re-emits the recorded tool calls and reply as real spans through the
 * runner's trace context, so the projection snapshot is indistinguishable
 * from a live run's: `t.calledTool` / `t.noFailedActions` read the same
 * observations they would live, and the recorded deliverables flow through
 * the same schema validation. The tests are never mocked; only the agent's
 * behavior is frozen. That is what makes a first verdict cost nothing:
 * `apo task run <task> --no-record` passes with no OPENROUTER_API_KEY, no
 * backend, and no account.
 *
 * Fixture resolution: `APO_RECORDED_SESSION=<path>` overrides; the default
 * is `recorded-session.json` sitting next to the task's `.eval.ts` file.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defineAdapter,
  registerApoTracing,
  type AdapterSession,
} from "@apo-ai/sdk/agent-task";
import {
  runSteerableChat,
  type ChatRequest,
} from "../../app/lib/agent/service.ts";
import { loadFiles } from "./lib/files.ts";
import { deliverableSchemas, collectDeliverablesFromState } from "./lib/deliverables.ts";
import type { AgentState } from "./agent/types.ts";

await registerApoTracing();

type RecordedToolCall = { tool: string; args: Record<string, unknown>; result: unknown };

type RecordedTurn = {
  response: string;
  toolCalls: RecordedToolCall[];
  usage?: { input_tokens: number; output_tokens: number } | null;
};

type RecordedSession = {
  fixtureVersion: 1;
  recordedAt: string;
  /** The model the recorded live run actually used. */
  model: string;
  turns: RecordedTurn[];
  deliverables: Record<string, unknown>;
};

const EMPTY_STATE: AgentState = { turnCount: 0, allToolCalls: [], fileContents: {}, agentResponses: [] };

/** Extra session fields the record-mode session carries for collection time. */
type RecordingSession = AdapterSession & {
  recordedTurns: RecordedTurn[];
  recordedModel: string;
};

export const recordedAiSdkAdapter = defineAdapter({
  name: "recorded-ai-sdk",
  deliverables: deliverableSchemas,

  turn: async ({ files, transcript }) => {
    if (transcript.length > 0) return null;
    try { return await files.read("instructions.md"); } catch { return "Extract all structured data from the invoice."; }
  },

  async initialize(ctx) {
    return { ...EMPTY_STATE, fileContents: loadFiles(ctx.files) };
  },

  async startSession(ctx) {
    const recordTo = process.env.APO_RECORD_FIXTURE;
    return recordTo
      ? liveSession(ctx, recordTo)
      : replaySession(ctx, await readFixture(fixturePath(ctx.taskDir)));
  },

  async collectDeliverables(ctx) {
    const recordTo = process.env.APO_RECORD_FIXTURE;
    if (recordTo) {
      const state = (ctx.state ?? EMPTY_STATE) as AgentState;
      const session = ctx.session as RecordingSession;
      const deliverables = collectDeliverablesFromState(state);
      await writeFixture(recordTo, {
        fixtureVersion: 1,
        recordedAt: new Date().toISOString(),
        model: session.recordedModel,
        turns: session.recordedTurns,
        deliverables,
      });
      return deliverables;
    }
    const fixture = await readFixture(fixturePath(ctx.taskDir));
    return fixture.deliverables;
  },
});

function fixturePath(taskDir: string): string {
  return process.env.APO_RECORDED_SESSION ?? join(taskDir, "recorded-session.json");
}

async function readFixture(path: string): Promise<RecordedSession> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `no recorded session at ${path}: record one first (one live run, needs OPENROUTER_API_KEY): ` +
        `APO_RECORD_FIXTURE=${path} apo task run <this-task>`,
    );
  }
  const fixture = JSON.parse(raw) as RecordedSession;
  if (fixture.fixtureVersion !== 1) {
    throw new Error(`unsupported recorded-session version at ${path}: ${String(fixture.fixtureVersion)}`);
  }
  return fixture;
}

async function writeFixture(path: string, fixture: RecordedSession): Promise<void> {
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

/** The live half: the same run the plain AI SDK adapter does, plus capture. */
function liveSession(ctx: { taskDir: string; state?: unknown }, _recordTo: string): RecordingSession {
  const state = (ctx.state ?? EMPTY_STATE) as AgentState;
  const model = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash-0731";
  const recordedTurns: RecordedTurn[] = [];

  return {
    runConfiguration: { model },
    recordedTurns,
    recordedModel: model,
    async sendUserTurn(turn: unknown, context: Parameters<AdapterSession["sendUserTurn"]>[1]) {
      state.turnCount++;
      const messages: ChatRequest["messages"] = [
        { role: "user", content: `${turn}\n\nAvailable files: ${Object.keys(state.fileContents).join(", ")}` },
      ];
      const result = await runSteerableChat(
        { messages, files: state.fileContents, taskDir: ctx.taskDir },
        { onProgress: context.notifyAgentEvent, inbox: { take: () => null } },
      );
      state.agentResponses.push(result.response);
      state.allToolCalls.push(...result.tool_calls);
      recordedTurns.push({
        response: result.response,
        toolCalls: result.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args, result: tc.result })),
        usage: result.usage,
      });
      return { response: result.response };
    },
  };
}

/**
 * The replay half: serve the fixture and re-emit its behavior as spans.
 * Every tool call becomes a TOOL observation (name + input + output) and
 * every reply a GENERATION observation, parented under the live Task Turn
 * span exactly like native telemetry would be.
 */
function replaySession(ctx: { task: { id: string } }, fixture: RecordedSession): AdapterSession {
  let turnIndex = 0;

  return {
    // "recorded:" prefix keeps the provenance honest in run metadata: this
    // run executed a frozen session of that model, not the model itself.
    runConfiguration: { model: `recorded:${fixture.model}` },
    async sendUserTurn(_turn: unknown, context) {
      const recorded = fixture.turns[turnIndex];
      if (!recorded) {
        throw new Error(
          `recorded session holds ${fixture.turns.length} turn(s); the runner asked for turn ${turnIndex + 1}`,
        );
      }
      turnIndex++;
      context.notifyAgentEvent({ kind: "run_start" });

      for (const call of recorded.toolCalls) {
        const spanId = context.trace.createSpan({
          task_id: ctx.task.id,
          ...(context.parentSpanId ? { parent_call_id: context.parentSpanId } : {}),
          step_name: call.tool,
          observation_type: "TOOL",
          tool_name: call.tool,
          input: call.args,
          metadata: { source: "recorded-session" },
        });
        context.trace.endSpan(spanId, {
          output: asRecordOutput(call.result),
          latency_ms: 3,
        });
        context.notifyAgentEvent({ kind: "tool_result", toolName: call.tool });
      }

      const replySpanId = context.trace.createSpan({
        task_id: ctx.task.id,
        ...(context.parentSpanId ? { parent_call_id: context.parentSpanId } : {}),
        step_name: fixture.model,
        observation_type: "GENERATION",
        model: fixture.model,
        metadata: {
          source: "recorded-session",
          // The recording's token counts are history, not this run's usage:
          // reported as span usage they would be priced (cost) and divided
          // by replay latency (tok/s) as if spent now. A replay spent nothing.
          ...(recorded.usage ? { recorded_usage: recorded.usage } : {}),
        },
      });
      context.trace.endSpan(replySpanId, {
        output: { text: recorded.response },
        latency_ms: 8,
      });
      context.notifyAgentEvent({ kind: "assistant_reply" });

      return { response: recorded.response };
    },
  };
}

function asRecordOutput(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === "object"
    ? (result as Record<string, unknown>)
    : { value: result };
}
