/**
 * FlowView — typed, derived access over a {@link Flow}. This is the read model
 * the assertion surface (`t`) queries. It hides all the filtering/derivation
 * so assertions stay one-liners.
 */

import type { Flow, FlowEvent } from "./types.ts";

type ToolCall = Extract<FlowEvent, { kind: "tool_call" }>;
type SkillLoad = Extract<FlowEvent, { kind: "skill_load" }>;
type SubagentCall = Extract<FlowEvent, { kind: "subagent_call" }>;
type Message = Extract<FlowEvent, { kind: "message" }>;

export class FlowView {
  readonly events: readonly FlowEvent[];
  readonly startedAt?: number;
  readonly endedAt?: number;

  constructor(flow: Flow) {
    this.events = flow.events;
    this.startedAt = flow.startedAt;
    this.endedAt = flow.endedAt;
  }

  get messages(): Message[] {
    return this.events.filter((e): e is Message => e.kind === "message");
  }

  get toolCalls(): ToolCall[] {
    return this.events.filter((e): e is ToolCall => e.kind === "tool_call");
  }

  get skillLoads(): SkillLoad[] {
    return this.events.filter((e): e is SkillLoad => e.kind === "skill_load");
  }

  get subagentCalls(): SubagentCall[] {
    return this.events.filter(
      (e): e is SubagentCall => e.kind === "subagent_call",
    );
  }

  get toolNamesInOrder(): string[] {
    return this.toolCalls.map((c) => c.name);
  }

  /** Last assistant message text — the agent's "reply". */
  get reply(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === "assistant") return this.messages[i]!.text;
    }
    return "";
  }

  /** Number of completed assistant turns. */
  get turnCount(): number {
    return this.messages.filter((m) => m.role === "assistant").length;
  }

  /** Tool or subagent calls that reported an error. */
  get failedActions(): number {
    return this.events.filter(
      (e) =>
        (e.kind === "tool_call" || e.kind === "subagent_call") &&
        e.status === "error",
    ).length;
  }

  get durationMs(): number {
    if (this.startedAt != null && this.endedAt != null) {
      return Math.max(0, this.endedAt - this.startedAt);
    }
    // Fallback: sum recorded latencies when no wall-clock span is available.
    return this.events.reduce((sum, e) => {
      if ("latencyMs" in e && typeof e.latencyMs === "number") {
        return sum + e.latencyMs;
      }
      return sum;
    }, 0);
  }
}
