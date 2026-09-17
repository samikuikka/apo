/**
 * Raw reasoning adapter — a real model call through plain fetch, recorded
 * with apo's own trace API.
 *
 * Why this adapter exists: the Vercel AI SDK v6's telemetry drops reasoning
 * tokens on the generateText path (upstream TODO in ai/dist), so an agent
 * traced only through `registerApoTracing()` reports "not reported" for the
 * reasoning dimension no matter what the provider sent. This adapter reads
 * the provider's real usage object directly — including
 * `completion_tokens_details.reasoning_tokens` — and records the GENERATION
 * span itself, so the reasoning dimension lands in apo exactly as any
 * OTel-emitting SDK that follows the GenAI convention would deliver it.
 *
 * The model call is real (OpenRouter); the usage is the provider's own
 * accounting, not synthesized.
 */
import { defineAdapter, getActiveApoRun } from "@apo-ai/sdk/agent-task";
import { loadFiles } from "./lib/files.ts";
import { deliverableSchemas, collectDeliverablesFromState } from "./lib/deliverables.ts";
import type { AgentState } from "./agent/types.ts";

const EMPTY_STATE: AgentState = { turnCount: 0, allToolCalls: [], fileContents: {}, agentResponses: [] };

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export const reasoningAdapter = defineAdapter({
  name: "raw-reasoning",
  deliverables: deliverableSchemas,

  turn: async ({ files, transcript }) => {
    if (transcript.length > 0) return null;
    try { return await files.read("instructions.md"); } catch { return "Answer the task."; }
  },

  async initialize(ctx) {
    return { ...EMPTY_STATE, fileContents: loadFiles(ctx.files) };
  },

  async startSession(ctx) {
    const state = (ctx.state ?? EMPTY_STATE) as AgentState;
    const model = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash";
    return {
      runConfiguration: { model },
      async sendUserTurn(turn: unknown, turnCtx) {
        state.turnCount++;
        const run = getActiveApoRun();
        // Nest under the runner's task.turn span when provided (same shape
        // the AI SDK telemetry produces), else under the run root.
        const parentSpanId = turnCtx?.parentSpanId ?? run?.parentSpanId ?? run?.trace.rootSpanId;
        // Inline the task files: this adapter has no tools, so the model must
        // see the file bodies in the prompt itself.
        const fileBlocks = Object.entries(state.fileContents)
          .map(([name, content]) => `--- ${name} ---\n${content}`)
          .join("\n\n");
        // Create the GENERATION span BEFORE the call so its timestamps frame
        // the real model time (the trace client encodes the recorded latency
        // into the end timestamp).
        const spanId = run
          ? run.trace.createSpan({
              task_id: run.taskId ?? "reasoning",
              parent_call_id: parentSpanId ?? undefined,
              step_name: "agent.generate",
              model,
              observation_type: "GENERATION",
            })
          : null;
        const startedAt = Date.now();
        const response = await fetch(
          (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1") +
            "/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "user",
                  content: `${String(turn)}\n\n${fileBlocks}`,
                },
              ],
            }),
          },
        );
        if (!response.ok) {
          if (spanId && run) {
            run.trace.endSpan(spanId, {
              latency_ms: Date.now() - startedAt,
              level: "ERROR",
              status_message: `model call failed: ${response.status}`,
            });
          }
          throw new Error(`model call failed: ${response.status} ${await response.text()}`);
        }
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: OpenRouterUsage;
          model?: string;
        };
        const text = body.choices?.[0]?.message?.content ?? "";
        const usage = body.usage;

        // End the generation with the provider's own usage accounting.
        // reasoning_tokens is forwarded only when the provider reported it —
        // unknown stays unknown.
        if (spanId && run) {
          run.trace.endSpan(spanId, {
            latency_ms: Date.now() - startedAt,
            output: text ? { text } : {},
            ...(usage?.prompt_tokens !== undefined
              ? { prompt_tokens: usage.prompt_tokens }
              : {}),
            ...(usage?.completion_tokens !== undefined
              ? { completion_tokens: usage.completion_tokens }
              : {}),
            ...(usage?.completion_tokens_details?.reasoning_tokens !== undefined
              ? { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens }
              : {}),
          });
        }

        state.agentResponses.push(text);
        return { response: text };
      },
    };
  },

  async collectDeliverables(ctx) {
    return collectDeliverablesFromState((ctx.state ?? EMPTY_STATE) as AgentState);
  },
});
