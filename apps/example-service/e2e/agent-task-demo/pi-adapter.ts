/**
 * pi adapter — the real third-party steering harness.
 *
 * pi (`@earendil-works/pi-coding-agent`, pi.dev) is a coding agent with
 * NATIVE mid-run steering: `session.steer()` queues a user message that pi
 * delivers "after the current assistant turn finishes executing its tool
 * calls, before the next LLM call" — exactly apo's `tool_results` boundary.
 * This adapter maps apo's steering contract onto that primitive, so a task
 * can demand "responds correctly to a mid-run steer" from a harness apo does
 * not own.
 *
 * pi emits no OTel of its own, so — like the Claude adapter — the adapter
 * mirrors observed activity into the trace as pi's session events arrive:
 * `tool_execution_end` → TOOL observation, assistant `message_end` →
 * GENERATION observation. Mirrors are emitted in arrival order while the
 * turn runs, so they interleave correctly with the runner's `task.steer`
 * event and `t.steerDelivered`'s post-steer-generation computation holds.
 *
 * Model/auth: pi's credential fallback ends at provider env vars;
 * OpenRouter's is `OPENROUTER_API_KEY`, which apo's runner already loads from
 * the task env. `PI_MODEL` selects the model by id (falls back to pi's
 * default, which is what `runConfiguration` then reports — the resolved
 * truth, never a guess).
 */
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  defineAdapter,
  registerApoTracing,
  type AgentProgressEvent,
  type AgentTaskTraceContext,
} from "@apo-ai/sdk/agent-task";

await registerApoTracing();

/**
 * The structural slice of pi's AgentSession this adapter reads. Declared
 * locally so tests can supply a fake without the real pi runtime, and so a
 * newer pi that grows fields still satisfies it.
 */
export interface PiSessionLike {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<"queued" | "handled">;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  dispose(): void;
  getLastAssistantText(): string | undefined;
  readonly model?: { id?: string } | undefined;
  setModel?(model: { id: string }): Promise<void>;
  readonly modelRuntime?: {
    getModels(providerId?: string): readonly { id: string }[];
  };
}

/** Structural shape of the pi session events the adapter routes. */
export type PiSessionEvent = {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: unknown;
  };
} & Record<string, unknown>;

/** Everything one run accumulates for deliverables. */
interface PiRunState {
  turnCount: number;
  lastResponse: string;
  toolLog: string[];
}

/** Pull readable text out of an assistant message's content blocks. */
function assistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

export interface PiAdapterOptions {
  /** Injectable for tests: replaces createAgentSession. */
  createSession?: (options: { cwd: string }) => Promise<{ session: PiSessionLike }>;
}

export function createPiAdapter(options: PiAdapterOptions = {}) {
  const createSession = options.createSession ?? defaultCreateSession;

  return defineAdapter({
    name: "pi-agent",
    deliverables: {
      result: z.object({ summary: z.string(), findings: z.array(z.string()) }),
    },

    turn: async ({ files, transcript }) => {
      if (transcript.length > 0) return null;
      try {
        return await files.read("instructions.md");
      } catch {
        return "Complete the task described in the working directory.";
      }
    },

    async initialize() {
      // Fresh containers per run — a spread of EMPTY_STATE would share the
      // toolLog array across every session in the process.
      return { turnCount: 0, lastResponse: "", toolLog: [] as string[] };
    },

    async startSession(ctx) {
      const state = (ctx.state ?? { turnCount: 0, lastResponse: "", toolLog: [] }) as unknown as PiRunState;
      const { session } = await createSession({ cwd: ctx.taskDir });

      await selectModel(session);

      // Per-turn plumbing: pi's listener is installed once per session, but
      // the trace context and progress notifier arrive per sendUserTurn.
      let currentTrace: AgentTaskTraceContext | undefined;
      let currentNotify: ((event: AgentProgressEvent) => void) | undefined;
      let turnActive = false;

      const mirrorTool = (toolName: string, result: unknown, isError: boolean): void => {
        currentTrace?.recordEvent({
          step_name: `pi ${toolName}`,
          observation_type: "TOOL",
          tool_name: toolName,
          metadata: { tool_result: result, ...(isError ? { failed: true } : {}) },
          output: { value: result },
        });
      };

      const mirrorGeneration = (message: {
        content?: unknown;
        model?: unknown;
      }): void => {
        const text = assistantText(message as Record<string, unknown>);
        if (text === "") return;
        const model = message.model;
        currentTrace?.recordEvent({
          step_name: "pi.chat",
          observation_type: "GENERATION",
          ...(typeof model === "string" ? { model } : {}),
          output: { text },
        });
      };

      session.subscribe((event) => {
        if (!turnActive) return;
        switch (event.type) {
          case "agent_start":
            currentNotify?.({ kind: "run_start" });
            break;
          case "tool_execution_end": {
            const toolName = String(event.toolName ?? "unknown");
            mirrorTool(toolName, event.result, event.isError === true);
            state.toolLog.push(toolName);
            currentNotify?.({ kind: "tool_result", toolName });
            break;
          }
          case "message_end": {
            const message = event.message;
            if (message?.role === "assistant") {
              mirrorGeneration(message);
              currentNotify?.({ kind: "assistant_reply" });
            }
            break;
          }
          default:
            break;
        }
      });

      return {
        runConfiguration: { model: session.model?.id ?? "pi-default" },

        async sendUserTurn(turn: unknown, context) {
          state.turnCount++;
          currentTrace = context.trace;
          currentNotify = context.notifyAgentEvent;
          turnActive = true;
          try {
            await session.prompt(String(turn));
          } finally {
            turnActive = false;
            currentNotify = undefined;
            currentTrace = undefined;
          }
          state.lastResponse = session.getLastAssistantText() ?? "";
          return { response: state.lastResponse };
        },

        async steer(input: unknown) {
          // pi's own queueing: delivered at the next tool boundary. The
          // disposition ("queued" while running) is pi's truth; whether the
          // agent REACTED is asserted afterwards by t.steerDelivered.
          await session.steer(String(input));
          return { boundary: "tool_results" as const };
        },

        close() {
          session.dispose();
          return Promise.resolve();
        },
      };
    },

    async collectDeliverables(ctx) {
      const state = (ctx.state ?? { turnCount: 0, lastResponse: "", toolLog: [] }) as unknown as PiRunState;
      return {
        result: {
          // Full text — never sliced: reports longer than a few hundred chars
          // were cut before their totals, failing deterministic checks.
          summary: state.lastResponse,
          findings: [...state.toolLog],
        },
      };
    },
  });
}

async function defaultCreateSession(options: { cwd: string }): Promise<{ session: PiSessionLike }> {
  const result = await createAgentSession({ cwd: options.cwd });
  return { session: result.session as unknown as PiSessionLike };
}

/**
 * Select the model by id when PI_MODEL names one pi knows; otherwise keep
 * pi's default. Either way the session reports the resolved id — apo never
 * guesses.
 */
async function selectModel(session: PiSessionLike): Promise<void> {
  const wanted = process.env.PI_MODEL;
  if (!wanted || !session.modelRuntime || !session.setModel) return;
  const found = session.modelRuntime.getModels().find((m) => m.id === wanted);
  if (found) await session.setModel(found);
}

export const piAdapter = createPiAdapter();
