/**
 * Anthropic JS SDK tracing integration for apo.
 *
 * Wraps an `Anthropic` client so `messages.create()` calls are
 * automatically traced. Tool calls and generations are captured without
 * any manual span code in the adapter.
 *
 * @example
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { createApoAnthropic } from "@apo/sdk/agent-task";
 *
 * async sendUserTurn(turn, { trace, parentSpanId }) {
 *   const client = createApoAnthropic(
 *     new Anthropic({ apiKey }),
 *     { trace, parentSpanId, taskId: ctx.task.id, turnNumber }
 *   );
 *   const response = await client.messages.create({
 *     model: "claude-sonnet-4-20250514",
 *     max_tokens: 1024,
 *     messages: [{ role: "user", content: String(turn) }],
 *     tools: [...],
 *   });
 *   const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
 *   return { response: text };
 * }
 * ```
 *
 * @module
 */

import type { AgentTaskTraceContext } from "../tracing.ts";
import { startGeneration, emitGenerationAndTools } from "./span-helpers.ts";

export interface CreateApoAnthropicOptions {
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
 * Minimal structural shape of the Anthropic client we intercept.
 */
interface AnthropicClientLike {
  messages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (...args: any[]) => Promise<any>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * The response shape we read from `messages.create()`.
 */
interface AnthropicResponseLike {
  model?: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input?: unknown }
    | { type: string }
  >;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Wrap an Anthropic client so `messages.create()` is traced.
 * Returns a Proxy-wrapped client — call it exactly as you would the
 * original. Non-streaming only; streaming responses pass through
 * untraced.
 *
 * For SDKs that emit OpenTelemetry natively (Claude Agent SDK, Vercel AI
 * SDK), prefer `configureApoTelemetry()` instead — no wrapper needed.
 * This manual wrapper is for the raw `@anthropic-ai/sdk` package or
 * custom clients that don't emit OTel on their own.
 */
export function createApoAnthropic<T extends AnthropicClientLike>(
  client: T,
  options: CreateApoAnthropicOptions,
): T {
  const { trace, parentSpanId, taskId, turnNumber } = options;
  const realCreate = client.messages.create.bind(client.messages);

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
      const response = (await realCreate(params)) as AnthropicResponseLike;
      const blocks = response.content ?? [];
      const text = blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolCalls = blocks
        .filter(
          (b): b is { type: "tool_use"; name: string; input?: unknown } =>
            b.type === "tool_use",
        )
        .map((b) => ({
          name: b.name,
          input: b.input,
        }));

      emitGenerationAndTools(trace, spanId, startedAt, {
        text: text || undefined,
        promptTokens: response.usage?.input_tokens,
        completionTokens: response.usage?.output_tokens,
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

  // Proxy that intercepts client.messages.create but passes
  // everything else through unchanged.
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "messages") {
        return new Proxy(target.messages, {
          get(messagesTarget, messagesProp) {
            if (messagesProp === "create") {
              return tracedCreate;
            }
            return Reflect.get(messagesTarget, messagesProp);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
