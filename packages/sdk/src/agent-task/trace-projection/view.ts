/**
 * TraceView — typed, capability-gated, derived access over a
 * {@link TraceProjectionSnapshot}. This is the read model the projection-first
 * assertion surface queries. It is the projection analogue of `FlowView`.
 *
 * The defining difference from `FlowView` is **capability honesty**: when the
 * snapshot declares a category of evidence `unavailable`, the derived numeric
 * facts (`durationMs`, `failedActions`, `turnCount`) return `undefined` rather
 * than zero — so an assertion like `t.maxDurationMs` can record an explicit
 * `unsupported` outcome instead of vacuously passing against a fabricated 0ms.
 *
 * `toolNamesInOrder` sorts by observation invocation time (`startedAt`) with a
 * deterministic span-ID tie-breaker — NOT array/completion order. This fixes
 * the drift where concurrent tools appeared in completion order.
 */

import type {
  EvidenceAvailability,
  ObservationStatus,
  TraceProjectionCapabilities,
  TraceProjectionMessage,
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "./types.ts";

/** A tool call derived from a `TOOL` observation. */
export interface TraceToolCall {
  spanId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: ObservationStatus;
  startedAt?: string;
}

/** A skill load derived from a `SKILL` observation. */
export interface TraceSkillLoad {
  spanId: string;
  skill: string;
  startedAt?: string;
}

/** A subagent delegation derived from an `AGENT` observation. */
export interface TraceSubagentCall {
  spanId: string;
  agent: string;
  output?: unknown;
  status: ObservationStatus;
  startedAt?: string;
}

/** Sentinel that sorts before every real timestamp in string comparison. */
const TIMESTAMPED_MIN = "";

/**
 * Comparison key for deterministic ordering by invocation time then span ID.
 * Missing `startedAt` sorts AFTER every timestamped observation (SPEC-130:
 * "Missing timestamps sort after timestamped observations").
 */
function invocationOrderKey(obs: TraceProjectionObservation): [number, string, string] {
  const hasTs = obs.startedAt != null ? 0 : 1;
  return [hasTs, obs.startedAt ?? "", obs.spanId];
}

export class TraceView {
  readonly snapshot: TraceProjectionSnapshot;

  constructor(snapshot: TraceProjectionSnapshot) {
    this.snapshot = snapshot;
  }

  /** Evidence availability for a capability. */
  requireCapability(
    capability: keyof TraceProjectionCapabilities,
  ): EvidenceAvailability {
    return this.snapshot.capabilities[capability];
  }

  /** Whether a capability is reported as available (not partial/unavailable). */
  private isAvailable(capability: keyof TraceProjectionCapabilities): boolean {
    return this.snapshot.capabilities[capability] === "available";
  }

  /** All chat messages flattened across generation observations, in order. */
  get messages(): readonly TraceProjectionMessage[] {
    const out: TraceProjectionMessage[] = [];
    for (const obs of this.sortedObservations) {
      if (obs.messages) out.push(...obs.messages);
    }
    return out;
  }

  /** Tool calls derived from `TOOL` observations, in invocation order. */
  get toolCalls(): readonly TraceToolCall[] {
    return this.sortedObservations
      .filter((o): o is TraceProjectionObservation & { type: "TOOL" } => o.type === "TOOL")
      .map((o) => ({
        spanId: o.spanId,
        name: o.toolName ?? o.name,
        input: o.toolParameters ?? o.input,
        output: o.toolResult ?? o.output,
        status: o.status,
        startedAt: o.startedAt,
      }));
  }

  /** Tool names in invocation order with deterministic span-ID tie-breaking. */
  get toolNamesInOrder(): readonly string[] {
    return this.toolCalls.map((c) => c.name);
  }

  /** Skill loads derived from `SKILL` observations, in invocation order. */
  get skillLoads(): readonly TraceSkillLoad[] {
    return this.sortedObservations
      .filter((o): o is TraceProjectionObservation & { type: "SKILL" } => o.type === "SKILL")
      .map((o) => ({ spanId: o.spanId, skill: o.name, startedAt: o.startedAt }));
  }

  /** Subagent delegations derived from `AGENT` observations, in invocation order. */
  get subagentCalls(): readonly TraceSubagentCall[] {
    return this.sortedObservations
      .filter((o): o is TraceProjectionObservation & { type: "AGENT" } => o.type === "AGENT")
      .map((o) => ({
        spanId: o.spanId,
        agent: o.name,
        output: o.output,
        status: o.status,
        startedAt: o.startedAt,
      }));
  }

  /** Last assistant message content — the agent's "reply". Empty if none. */
  get reply(): string {
    const msgs = this.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === "assistant") return msgs[i]!.content;
    }
    return "";
  }

  /**
   * Number of completed assistant turns, or `undefined` when message evidence
   * is unavailable (capability honesty).
   */
  get turnCount(): number | undefined {
    if (!this.isAvailable("messages")) return undefined;
    return this.messages.filter((m) => m.role === "assistant").length;
  }

  /**
   * Number of tool/subagent observations that reported an error, or `undefined`
   * when error evidence is unavailable (capability honesty).
   */
  get failedActions(): number | undefined {
    if (!this.isAvailable("errors")) return undefined;
    return this.sortedObservations.filter(
      (o) => (o.type === "TOOL" || o.type === "AGENT") && o.status === "error",
    ).length;
  }

  /**
   * Total execution duration in milliseconds, or `undefined` when timing
   * evidence is unavailable (capability honesty). Uses trace-level
   * startedAt/endedAt when present.
   */
  get durationMs(): number | undefined {
    if (!this.isAvailable("timing")) return undefined;
    const { startedAt, endedAt } = this.snapshot.trace;
    if (startedAt != null && endedAt != null) {
      const ms = Date.parse(endedAt) - Date.parse(startedAt);
      return Number.isNaN(ms) ? undefined : Math.max(0, ms);
    }
    return undefined;
  }

  /**
   * Observations sorted deterministically by invocation time then span ID.
   * Memoized per TraceView instance since the snapshot is immutable.
   */
  private get sortedObservations(): readonly TraceProjectionObservation[] {
    if (this._sorted !== undefined) return this._sorted;
    // Copy to a mutable array, then sort by invocation key: missing timestamps
    // (key prefix 1) sort after timestamped ones (prefix 0), then by span ID
    // for determinism.
    const sorted = [...this.snapshot.observations].sort((a, b) => {
      const ka = invocationOrderKey(a);
      const kb = invocationOrderKey(b);
      return (
        ka[0] - kb[0] ||
        ka[1].localeCompare(kb[1]) ||
        ka[2].localeCompare(kb[2])
      );
    });
    this._sorted = sorted;
    return sorted;
  }
  private _sorted: readonly TraceProjectionObservation[] | undefined;
}

// Keep the timestamp sentinel referenced for clarity — documents that empty
// string is the "earliest" timestamp in lexicographic ordering.
void TIMESTAMPED_MIN;
