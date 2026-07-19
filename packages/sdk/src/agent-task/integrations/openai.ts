/**
 * OpenAI JS SDK tracing integration for apo.
 *
 * Wraps an `OpenAI` client so `chat.completions.create()` calls are
 * automatically traced. Tool calls and generations are captured without
 * any manual span code in the adapter.
 *
 * Uses a Proxy to intercept the `create` method, then emits GENERATION +
 * TOOL spans through the trace context. The FlowTee picks these up and
 * builds the Flow that `t.calledTool` reads.
 *
 * @example
 * ```ts
 * import OpenAI from "openai";
 * import { createApoOpenAI } from "@apo/sdk/agent-task";
 *
 * async sendUserTurn(turn, { trace, parentSpanId }) {
 *   const client = createApoOpenAI(
 *     new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" }),
 *     { trace, parentSpanId, taskId: ctx.task.id, turnNumber }
 *   );
 *   const response = await client.chat.completions.create({
 *     model: "google/gemini-2.5-flash-lite",
 *     messages: [{ role: "user", content: String(turn) }],
 *     tools: [...],
 *   });
 *   return { response: response.choices[0].message.content ?? "" };
 * }
 * ```
 *
 * @module
 */

import type { AgentTaskTraceContext } from "../tracing.ts";
import { startGeneration, emitGenerationAndTools, safeParse } from "./span-helpers.ts";

export interface CreateApoOpenAIOptions {
  /** The tee'd trace context from `sendUserTurn`'s second argument. */
  trace: AgentTaskTraceContext;
  /** The parent span id for this turn (from `sendUserTurn`'s context). */
  parentSpanId?: string;
  /** Optional task id, surfaced in span metadata. */
  taskId?: string;
  /** Optional turn number, surfaced in span metadata. */
  turnNumber?: number;
}

/**
 * Minimal structural shape of the OpenAI client we need to intercept.
 * We avoid importing `openai` at the type level so this module doesn't
 * take a runtime dependency — the wrapper works with any client that has
 * `chat.completions.create`.
 *
 * The `create` signature uses a broad type so the OpenAI SDK's overloaded
 * `create` method (which has specific param types) is assignable to this.
 */
interface OpenAIClientLike {
  chat: {
    completions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (...args: any[]) => Promise<any>;
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * The response shape we read from `chat.completions.create()`.
 */
interface OpenAIResponseLike {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Wrap an OpenAI client so `chat.completions.create()` is traced.
 * Returns a Proxy-wrapped client — call it exactly as you would the
 * original. Non-streaming only; streaming responses pass through
 * untraced.
 *
 * For SDKs that emit OpenTelemetry natively (OpenAI Agents SDK, Vercel AI
 * SDK, Claude Agent SDK), prefer `configureApoTelemetry()` instead — no
 * wrapper needed. This manual wrapper is for the raw `openai` package or
 * custom clients that don't emit OTel on their own.
 */
export function createApoOpenAI<T extends OpenAIClientLike>(
  client: T,
  options: CreateApoOpenAIOptions,
): T {
  const { trace, parentSpanId, taskId, turnNumber } = options;
  const realCreate = client.chat.completions.create.bind(client.chat.completions);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tracedCreate = async (...args: any[]): Promise<any> => {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const model = String(params.model ?? "unknown");

    // Non-streaming: trace fully. Streaming (stream: true): pass through.
    if (params.stream === true) {
      return realCreate(params);
    }

    const { spanId, startedAt } = startGeneration(trace, {
      model,
      system: typeof params.system === "string" ? params.system : undefined,
      messages: params.messages,
      parentSpanId,
      taskId,
      turnNumber,
    });

    try {
      const response = (await realCreate(params)) as OpenAIResponseLike;
      const message = response.choices?.[0]?.message;
      const text = message?.content ?? undefined;
      const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
        name: tc.function?.name ?? "unknown",
        input: tc.function?.arguments ? safeParse(tc.function.arguments) : undefined,
      }));

      emitGenerationAndTools(trace, spanId, startedAt, {
        text,
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
        toolCalls,
        taskId,
        turnNumber,
      });

      return response;
    } catch (error) {
      emitGenerationAndTools(trace, spanId, startedAt, {
        taskId,
        turnNumber,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  };

  // Proxy that intercepts client.chat.completions.create but passes
  // everything else through unchanged.
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "chat") {
        return new Proxy(target.chat, {
          get(chatTarget, chatProp) {
            if (chatProp === "completions") {
              return new Proxy(chatTarget.completions, {
                get(completionsTarget, completionsProp) {
                  if (completionsProp === "create") {
                    return tracedCreate;
                  }
                  return Reflect.get(completionsTarget, completionsProp);
                },
              });
            }
            return Reflect.get(chatTarget, chatProp);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
