/**
 * AI SDK adapter — the minimal "plug your agent into apo" example.
 *
 * The adapter does ONE thing: hand each turn to the agent and record what it
 * did. It knows nothing about the model, the tools, the prompt, or the
 * multi-step loop — all of that lives in the agent itself
 * (`app/lib/agent/service.ts`). This is the shape real adoption takes: the
 * user's agent is their code; apo's adapter is the thin membrane that drives
 * it turn-by-turn and turns its output into deliverables.
 *
 * Tracing is automatic: `handleChat` runs `generateText` with
 * `experimental_telemetry` enabled in this same process, and
 * `registerApoTracing()` routes the emitted `gen_ai.*` spans to the active
 * run. No per-call wrapper, no OTLP — the spans are observed in-process.
 *
 * For a full-featured example (multi-turn conversation, custom prompt, richer
 * deliverable parsing), see `real-agent-adapter.ts`.
 */
import { defineAdapter, registerApoTracing, connectMcpServers } from "@apo-ai/sdk/agent-task";
import { handleChat, type ChatRequest } from "../../app/lib/agent/service.ts";
import { loadFiles } from "./lib/files.ts";
import { deliverableSchemas, collectDeliverablesFromState } from "./lib/deliverables.ts";
import { resolveMcpServerPaths } from "./lib/mcp.ts";
import type { AgentState } from "./agent/types.ts";

await registerApoTracing();

const EMPTY_STATE: AgentState = { turnCount: 0, allToolCalls: [], fileContents: {}, agentResponses: [] };

export const aiSdkAdapter = defineAdapter({
  name: "ai-sdk-agent",
  deliverables: deliverableSchemas,

  turn: async ({ files, transcript }) => {
    if (transcript.length > 0) return null;
    try { return await files.read("instructions.md"); } catch { return "Extract all structured data from the invoice."; }
  },

  async initialize(ctx) {
    return { ...EMPTY_STATE, fileContents: loadFiles(ctx.files) };
  },

  async startSession(ctx) {
    const state = (ctx.state ?? EMPTY_STATE) as AgentState;
    // report the same resolved model the agent uses (service.ts
    // getModel() reads OPENROUTER_MODEL with the same default). apo never
    // picks the model — the adapter resolves and reports the truth.
    const model = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash";

    // Task-declared MCP servers (TaskDefinition.mcpServers): connect once
    // per session, merge the raw namespaced tools into the agent's tool
    // record, close when the session ends — same pattern as the real-agent
    // adapter; no budget wrapping on the agent plane.
    const mcp = ctx.task.mcpServers?.length
      ? await connectMcpServers(resolveMcpServerPaths(ctx.task.mcpServers, ctx.taskDir))
      : undefined;

    return {
      runConfiguration: { model },
      ...(mcp ? { close: () => mcp.cleanup() } : {}),
      async sendUserTurn(turn: unknown) {
        state.turnCount++;
        const messages: ChatRequest["messages"] = [
          { role: "user", content: `${turn}\n\nAvailable files: ${Object.keys(state.fileContents).join(", ")}` },
        ];
        // The agent owns its tools, model, and prompt. The adapter just calls it.
        const result = await handleChat({
          messages,
          files: state.fileContents,
          taskDir: ctx.taskDir,
          ...(mcp ? { extraTools: mcp.tools } : {}),
        });
        state.agentResponses.push(result.response);
        state.allToolCalls.push(...result.tool_calls);
        return { response: result.response };
      },
    };
  },

  async collectDeliverables(ctx) {
    return collectDeliverablesFromState((ctx.state ?? EMPTY_STATE) as AgentState);
  },
});
