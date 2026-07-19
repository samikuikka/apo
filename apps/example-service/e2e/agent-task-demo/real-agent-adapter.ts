/**
 * real-agent adapter — full-featured example: multi-turn conversation,
 * custom prompt, and richer deliverable parsing.
 *
 * Like `ai-sdk-adapter.ts`, this adapter does not own the agent logic. It
 * calls `handleChat` (the agent, in `app/lib/agent/service.ts`) with a custom
 * system prompt + step limit, then parses the agent's response into
 * structured findings. The model, tools, and multi-step loop stay in the
 * agent — the adapter only decides the conversation shape and how to turn the
 * response into deliverables.
 *
 * Tracing is automatic via `registerApoTracing()` + `handleChat`'s
 * `experimental_telemetry` (same process).
 */
import { defineAdapter, registerApoTracing } from "@apo/sdk/agent-task";
import { handleChat, type ChatRequest } from "../../app/lib/agent/service.ts";
import type { AgentState, RealAgentDeliverables } from "./agent/types.ts";
import { loadFiles } from "./lib/files.ts";
import { REAL_AGENT_SYSTEM_PROMPT, buildWorkflowMessage } from "./lib/prompts.ts";
import { realAgentDeliverableSchemas, collectRealAgentDeliverables } from "./lib/deliverables.ts";

await registerApoTracing();

const EMPTY_STATE: AgentState = { turnCount: 0, allToolCalls: [], fileContents: {}, agentResponses: [] };

export type { RealAgentDeliverables } from "./agent/types.ts";

export const realAgentAdapter = defineAdapter({
  name: "real-agent",
  deliverables: realAgentDeliverableSchemas,

  turn: async ({ files, transcript }) => {
    if (transcript.length > 0) return null;
    try { return await files.read("instructions.md"); } catch { return null; }
  },

  async initialize(ctx) {
    return { ...EMPTY_STATE, fileContents: loadFiles(ctx.files) };
  },

  async startSession(ctx) {
    const state = (ctx.state ?? EMPTY_STATE) as AgentState;
    return {
      async sendUserTurn(turn: unknown) {
        state.turnCount++;
        const fileList = Object.keys(state.fileContents).map((f) => `- ${f}`).join("\n");
        const messages: ChatRequest["messages"] = [{
          role: "user",
          content: buildWorkflowMessage(turn, fileList),
        }];
        // The agent owns its tools + model. The adapter passes the prompt + step limit.
        const result = await handleChat({
          messages,
          files: state.fileContents,
          taskDir: ctx.taskDir,
          system: REAL_AGENT_SYSTEM_PROMPT,
          maxSteps: 8,
        });
        state.agentResponses.push(result.response);
        state.allToolCalls.push(...result.tool_calls);
        return { response: result.response };
      },
    };
  },

  async collectDeliverables(ctx) {
    const state = (ctx.state ?? EMPTY_STATE) as AgentState;
    return collectRealAgentDeliverables(state, ctx.files.length);
  },
});
