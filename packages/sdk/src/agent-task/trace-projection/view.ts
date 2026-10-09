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
import { TASK_STEER_SPAN_NAME } from "../run/steer-scheduler.ts";

/** The span name `runTask` gives each Task Turn (one `sendUserTurn` call). */
export const TASK_TURN_SPAN_NAME = "task.turn";

/** One mid-run steer, derived from a `task.steer` observation. */
export interface TraceSteer {
  /** 1-based, registration order across the run. */
  number: number;
  /** Scripted turn the steer targeted. */
  turn: number;
  label?: string;
  /**
   * The serialized trigger (`{"toolResults":2}`, `"runStart"`). Records
   * carry the trigger as an object — the local tee embeds the SteerRecord
   * directly and the canonical path re-parses its JSON — while the event
   * metadata carries the pre-stringified form; both render identically.
   */
  trigger: string;
  message: unknown;
  status: "delivered" | "undelivered" | "error";
  /** ISO timestamp of successful delivery (wall clock, display only). */
  deliveredAt?: string;
  /**
   * The steer observation's own `startedAt` — the snapshot-clock position of
   * the delivery. Window/delivery comparisons use THIS, not `deliveredAt`:
   * local tee snapshots timestamp with a monotonic clock (performance.now
   * epoch), so a wall-clock deliveredAt is not comparable to sibling
   * observations, while the steer observation's own timestamp always is.
   */
  spanStartedAt?: string;
  /** The steer observation's span id — the deterministic tie-breaker. */
  spanId: string;
  boundary?: string;
  reason?: string;
}

/**
 * Extract the SteerRecord from a `task.steer` observation's output.
 *
 * Two shapes exist, one per snapshot source:
 * - local tee: the record object sits directly in `output`.
 * - canonical backend: `recordEvent` output exports as `gen_ai.output.messages`
 *   / `gen_ai.response.text`, so the record arrives JSON-stringified inside
 *   `{ text, messages: [{ role: "assistant", content }] }`.
 * Recognized by the presence of a numeric `number` — anything else is not a
 * steer record and yields undefined (the observation is then skipped).
 */
function steerRecordFrom(
  obs: TraceProjectionObservation,
): Record<string, unknown> | undefined {
  const output = obs.output;
  if (!output || typeof output !== "object") return undefined;

  const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === "object" &&
    typeof (v as { number?: unknown }).number === "number"
      ? (v as Record<string, unknown>)
      : undefined;

  const direct = asRecord(output);
  if (direct) return direct;

  const tryParse = (text: unknown): Record<string, unknown> | undefined => {
    if (typeof text !== "string") return undefined;
    try {
      return asRecord(JSON.parse(text));
    } catch {
      return undefined;
    }
  };

  const fromText = tryParse((output as { text?: unknown }).text);
  if (fromText) return fromText;

  const messages = (output as { messages?: unknown }).messages;
  if (Array.isArray(messages)) {
    const content = (messages[0] as { content?: unknown } | undefined)?.content;
    const fromMessage = tryParse(content);
    if (fromMessage) return fromMessage;
  }
  return undefined;
}

/** Parse a `task.steer` observation's output into a TraceSteer. */
function traceSteerFrom(obs: TraceProjectionObservation): TraceSteer | undefined {
  const meta = obs.metadata as Record<string, unknown> | undefined;
  const record = steerRecordFrom(obs);
  const number =
    typeof record?.number === "number" ? record.number
    : typeof meta?.steerNumber === "number" ? meta.steerNumber
    : undefined;
  if (number === undefined) return undefined;
  const source: Record<string, unknown> = record ?? {};
  const read = (key: string): unknown =>
    source[key] !== undefined ? source[key] : meta?.[key];
  const status = read("status");
  const steer: TraceSteer = {
    number,
    spanId: obs.spanId,
    turn: typeof read("turn") === "number" ? (read("turn") as number) : 1,
    trigger: triggerToString(read("trigger")),
    message: source.message,
    ...(isSteerStatus(status) ? { status } : { status: "undelivered" }),
  };
  const label = read("label");
  if (typeof label === "string") steer.label = label;
  const deliveredAt = read("deliveredAt");
  if (typeof deliveredAt === "string") steer.deliveredAt = deliveredAt;
  if (obs.startedAt !== undefined) steer.spanStartedAt = obs.startedAt;
  const boundary = read("boundary");
  if (typeof boundary === "string") steer.boundary = boundary;
  const reason = read("reason");
  if (typeof reason === "string") steer.reason = reason;
  return steer;
}

function isSteerStatus(v: unknown): v is TraceSteer["status"] {
  return v === "delivered" || v === "undelivered" || v === "error";
}

/**
 * The trigger as text. Real records carry it as an object (see
 * {@link TraceSteer.trigger}); metadata carries the JSON string. Anything
 * else — absent, or unserializable — reads as `"unknown"`.
 */
function triggerToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object") {
    try {
      return JSON.stringify(v) ?? "unknown";
    } catch {
      // Unserializable (e.g. cyclic) — treat as unparsed.
    }
  }
  return "unknown";
}

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

/** One Task Turn, derived from a `task.turn` observation. */
export interface TraceTurn {
  /** 1-based, in invocation order. */
  turnNumber: number;
  spanId: string;
  durationMs?: number;
  status: ObservationStatus;
}

export type TokenKind = "input" | "output" | "total";

/**
 * Token usage summed over a scope (the whole agent execution, or one turn).
 * When `unreported` is non-zero, `tokens` is only a lower bound.
 */
export interface TraceTokenTally {
  tokens: number;
  /**
   * Observations that reported a count, including a step whose count its
   * parent call's own larger count superseded.
   */
  reported: number;
  /**
   * LLM calls in scope whose count is unknown or untrustworthy: a GENERATION
   * that reported no usage for the dimension, or an errored call (a provider
   * error often drops the final usage event, so its count may be short) —
   * except a step beneath a call whose own count is complete, which covers it.
   */
  unreported: number;
}

/**
 * Comparison key for deterministic ordering by invocation time then span ID.
 * Missing `startedAt` sorts AFTER every timestamped observation.
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
    // `usage` is optional on snapshots written before it existed.
    return this.snapshot.capabilities[capability] ?? "unavailable";
  }

  /** Whether a capability is reported as available (not partial/unavailable). */
  private isAvailable(capability: keyof TraceProjectionCapabilities): boolean {
    return this.requireCapability(capability) === "available";
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

  /**
   * Mid-run steers, derived from `task.steer` observations, in number order.
   * Empty when the trace carries none — steering assertions fail closed on
   * the empty case instead of passing vacuously.
   */
  get steers(): readonly TraceSteer[] {
    const out: TraceSteer[] = [];
    for (const obs of this.sortedObservations) {
      if (obs.name !== TASK_STEER_SPAN_NAME) continue;
      const steer = traceSteerFrom(obs);
      if (steer) out.push(steer);
    }
    return out.sort((a, b) => a.number - b.number);
  }

  /**
   * Whether an observation started after the steer observation, using the
   * same ordering key as everywhere else in this class (startedAt, then
   * span id). The id tie-break matters on the local tee path, whose ISO
   * timestamps truncate to milliseconds — a steer and the generation that
   * consumes it can share one.
   */
  private static startedAfter(
    obs: TraceProjectionObservation,
    steer: TraceSteer,
  ): boolean {
    if (obs.startedAt == null) return true;
    if (steer.spanStartedAt == null) return false;
    if (obs.startedAt !== steer.spanStartedAt) {
      return obs.startedAt > steer.spanStartedAt;
    }
    return obs.spanId > steer.spanId;
  }

  /**
   * A TraceView over the run after steer n was delivered: observations that
   * started after the steer's delivery timestamp (the first generation that
   * consumed it through run end). Missing timestamps sort after timestamped
   * observations per the projection contract, so they belong to the window
   * too. An undelivered steer yields an empty view — assertions inside it
   * fail on missing evidence rather than passing vacuously.
   */
  windowAfterSteer(n: number): TraceView {
    const steer = this.steers.find((s) => s.number === n);
    if (!steer) {
      throw new Error(`No steer number ${n} in this trace.`);
    }
    if (steer.spanStartedAt === undefined) {
      return new TraceView({ ...this.snapshot, observations: [] });
    }
    const filtered = this.snapshot.observations.filter(
      (o) => o.spanId !== steer.spanId && TraceView.startedAfter(o, steer),
    );
    return new TraceView({ ...this.snapshot, observations: filtered });
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
   * Task Turns in invocation order, or `undefined` when timing evidence is
   * not available. Each is one `task.turn` span: the adapter's whole
   * `sendUserTurn` call for that turn.
   */
  get turns(): readonly TraceTurn[] | undefined {
    if (!this.isAvailable("timing")) return undefined;
    return this.turnSpans
      .map((o, i) => ({
        turnNumber: i + 1,
        spanId: o.spanId,
        ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
        status: o.status,
      }));
  }

  /**
   * Tokens the agent under test spent: usage on observations inside
   * `task.turn` spans (every turn, or only turn `turn`). Work outside the
   * turns — the evaluation phase's judges, adapter setup — is not the
   * agent's and is excluded. `undefined` when usage evidence is not
   * available or the requested turn does not exist.
   */
  /** How many Task Turns ran — independent of timing evidence. */
  get turnCountFromSpans(): number {
    return this.turnSpans.length;
  }

  tokens(kind: TokenKind, opts?: { turn?: number }): TraceTokenTally | undefined {
    if (!this.isAvailable("usage")) return undefined;
    const turnSpans = this.turnSpans;
    let roots: readonly TraceProjectionObservation[];
    if (opts?.turn !== undefined) {
      const one = turnSpans[opts.turn - 1];
      if (!one) return undefined;
      roots = [one];
    } else {
      roots = turnSpans;
    }
    const tally: TraceTokenTally = { tokens: 0, reported: 0, unreported: 0 };
    const children = this.childrenByParent;
    const isLlmCall = (o: TraceProjectionObservation): boolean =>
      o.type === "GENERATION" || o.usage != null;
    // A per-step call of the call above it — not a tool or agent span, which
    // run separate calls even when they carry a rolled-up count.
    const isStep = (o: TraceProjectionObservation): boolean =>
      isLlmCall(o) && o.type !== "TOOL" && o.type !== "AGENT";

    // Every observation below the roots, each visited once, parents first.
    const order: TraceProjectionObservation[] = [];
    const visited = new Set<string>(roots.map((r) => r.spanId));
    const topLevel = roots.flatMap((r) => children.get(r.spanId) ?? []);
    const stack = [...topLevel];
    const scopeChildren = new Map<string, TraceProjectionObservation[]>();
    while (stack.length > 0) {
      const obs = stack.pop()!;
      if (visited.has(obs.spanId)) continue;
      visited.add(obs.spanId);
      order.push(obs);
      const kids = (children.get(obs.spanId) ?? []).filter((c) => !visited.has(c.spanId));
      scopeChildren.set(obs.spanId, kids);
      for (const kid of kids) stack.push(kid);
    }

    // Usage nests: an LLM call can carry the sum of its per-step calls
    // directly beneath it (Vercel's ai.generateText over its doGenerate
    // steps), and which of the two a producer records differs between the
    // local and canonical paths. So a call's own count covers its direct step
    // children — it counts the larger of the two, never both — and a
    // complete own count also covers a step whose usage is unknown (a retried
    // attempt). Anything reached through another span (a tool that runs a
    // subagent) is a separate call and adds.
    const effective = new Map<string, { tokens: number | undefined; unreported: number }>();
    for (let i = order.length - 1; i >= 0; i--) {
      const obs = order[i]!;
      const { count, complete } = tokenCount(obs, kind);
      if (count !== undefined) tally.reported += 1;
      const ownKnown = complete && obs.status !== "error";
      let steps: number | undefined;
      let stepsUnreported = 0;
      let separate: number | undefined;
      let separateUnreported = 0;
      for (const child of scopeChildren.get(obs.spanId) ?? []) {
        const c = effective.get(child.spanId);
        if (!c) continue;
        if (isStep(child)) {
          if (c.tokens !== undefined) steps = (steps ?? 0) + c.tokens;
          stepsUnreported += c.unreported;
        } else {
          if (c.tokens !== undefined) separate = (separate ?? 0) + c.tokens;
          separateUnreported += c.unreported;
        }
      }
      const own =
        count === undefined ? steps : steps === undefined ? count : Math.max(count, steps);
      const unreported =
        (isLlmCall(obs) && !ownKnown ? 1 : 0) +
        (isLlmCall(obs) && ownKnown ? 0 : stepsUnreported) +
        separateUnreported;
      effective.set(obs.spanId, {
        tokens: own === undefined && separate === undefined ? undefined : (own ?? 0) + (separate ?? 0),
        unreported,
      });
    }
    for (const obs of topLevel) {
      const e = effective.get(obs.spanId);
      if (!e) continue;
      tally.tokens += e.tokens ?? 0;
      tally.unreported += e.unreported;
      effective.delete(obs.spanId);
    }
    return tally;
  }

  /**
   * The run's own Task Turns: `task.turn` observations with no `task.turn`
   * ancestor (a nested run or a user span of the same name inside a turn is
   * part of that turn, not a turn of its own). Turns run sequentially, so
   * invocation order is turn order.
   */
  private get turnSpans(): readonly TraceProjectionObservation[] {
    if (this._turnSpans !== undefined) return this._turnSpans;
    const byId = new Map(this.snapshot.observations.map((o) => [o.spanId, o]));
    const insideAnotherTurn = (obs: TraceProjectionObservation): boolean => {
      const visited = new Set<string>([obs.spanId]);
      let parentId = obs.parentSpanId;
      while (parentId !== undefined && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) return false;
        if (parent.name === TASK_TURN_SPAN_NAME) return true;
        parentId = parent.parentSpanId;
      }
      return false;
    };
    this._turnSpans = this.sortedObservations.filter(
      (o) => o.name === TASK_TURN_SPAN_NAME && !insideAnotherTurn(o),
    );
    return this._turnSpans;
  }
  private _turnSpans: readonly TraceProjectionObservation[] | undefined;

  private get childrenByParent(): ReadonlyMap<string, TraceProjectionObservation[]> {
    if (this._children !== undefined) return this._children;
    const children = new Map<string, TraceProjectionObservation[]>();
    for (const obs of this.snapshot.observations) {
      if (obs.parentSpanId == null) continue;
      const list = children.get(obs.parentSpanId);
      if (list) list.push(obs);
      else children.set(obs.parentSpanId, [obs]);
    }
    this._children = children;
    return children;
  }
  private _children: ReadonlyMap<string, TraceProjectionObservation[]> | undefined;

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

/**
 * The observation's count for `kind`. `complete` is false when a dimension the
 * count needs was not reported — a total with only input known is a lower
 * bound, not a total.
 */
function tokenCount(
  obs: TraceProjectionObservation,
  kind: TokenKind,
): { count: number | undefined; complete: boolean } {
  // Canonical snapshots serialize unreported dimensions as null, and some
  // SDKs record NaN for "provider reported nothing": both are unknown.
  const known = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const input = known(obs.usage?.inputTokens);
  const output = known(obs.usage?.outputTokens);
  if (kind === "input") return { count: input, complete: input !== undefined };
  if (kind === "output") return { count: output, complete: output !== undefined };
  if (input === undefined && output === undefined) return { count: undefined, complete: false };
  return {
    count: (input ?? 0) + (output ?? 0),
    complete: input !== undefined && output !== undefined,
  };
}
