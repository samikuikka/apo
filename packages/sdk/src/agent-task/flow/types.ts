/**
 * Flow — the canonical, source-agnostic recording of "what happened" during
 * an agent run. This is the single substrate the testing framework reads.
 *
 * It is deliberately neutral: it does not know about our trace, the AI SDK,
 * OpenAI, Anthropic, etc. Concrete sources are converted into a {@link Flow}
 * by a normalizer (see `fromApoTrace`, etc.). The framework depends only on
 * this interface — that is what hides the source complexity.
 */

export type ToolCallStatus = "ok" | "error";

export type FlowEvent =
  | { kind: "message"; role: "user" | "assistant" | "system"; text: string; ts?: number }
  | {
      kind: "tool_call";
      name: string;
      input?: unknown;
      output?: unknown;
      status?: ToolCallStatus;
      latencyMs?: number;
      ts?: number;
    }
  | { kind: "skill_load"; skill: string; ts?: number }
  | {
      kind: "subagent_call";
      agent: string;
      output?: unknown;
      status?: ToolCallStatus;
      latencyMs?: number;
      ts?: number;
    };

export type Flow = {
  /** Ordered events — the timeline of the run. */
  events: readonly FlowEvent[];
  /** Wall-clock start/end, when known. Sources without clocks may omit them. */
  startedAt?: number;
  endedAt?: number;
};
