/**
 * Shared types for the example agent.
 *
 * Agent-level concerns — they describe what the agent tracks and produces,
 * not how apo runs it. The deliverable schemas + parsers that used to live
 * here have moved to `../lib/deliverables.ts`.
 */

/** A single tool call the agent made, tracked for the deliverable report. */
export type TrackedToolCall = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
};

/** State accumulated across turns within one session. */
export type AgentState = {
  turnCount: number;
  allToolCalls: TrackedToolCall[];
  fileContents: Record<string, string>;
  agentResponses: string[];
};

/** Deliverable type used by test<RealAgentDeliverables> in eval files. */
export type RealAgentDeliverables = {
  result: { summary: string; findings: string[] };
  tool_log: {
    total_calls: number;
    tools_used: string[];
    details: Array<{ tool: string; args: Record<string, unknown>; result: unknown }>;
  };
  stats: {
    turn_count: number;
    file_count: number;
    total_tool_calls: number;
    unique_tools: string[];
  };
};
