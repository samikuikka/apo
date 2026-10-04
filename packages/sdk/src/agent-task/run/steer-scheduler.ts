/**
 * Steer scheduler — the run-plane half of steering.
 *
 * One shared, adapter-agnostic implementation of "when does a steer fire":
 * the scheduler counts the adapter's progress events per turn and delivers
 * due steers through `session.steer()` when their trigger is satisfied. The
 * adapter provides *observe* (progress events) and *inject* (steer); the
 * runner stays the single arbiter of timing so a `when: { toolResults: 2 }`
 * schedule means the same thing on every harness.
 *
 * All state transitions are serialized through one promise chain: progress
 * events are processed in arrival order, steers due at the same boundary
 * fire in registration order, and `onTurnEnd` awaits any in-flight delivery
 * before finalizing — a boundary-race steer still lands if the harness
 * accepted it. Delivery failures never throw into the agent's turn: they are
 * recorded on the SteerRecord and the trace, and the check (`t.steerDelivered`)
 * decides what they mean.
 */

import type { AgentTaskTraceContext } from "../tracing.ts";
import type { AdapterSession, AgentProgressEvent } from "../adapter/types.ts";
import type { SteerSpec, SteerTrigger } from "../steer.ts";
import type { SteerRecord } from "./types.ts";

/** The span name the scheduler's `task.steer` events carry. */
export const TASK_STEER_SPAN_NAME = "task.steer";

export interface SteerScheduler {
  /** A turn started: resets its progress counters. */
  onTurnStart(turnNumber: number): Promise<void>;
  /** One progress event arrived; may deliver due steers (serialized, ordered). */
  onProgressEvent(turnNumber: number, event: AgentProgressEvent): Promise<void>;
  /** A turn ended: marks its un-fired steers undelivered. */
  onTurnEnd(turnNumber: number): Promise<void>;
  /** The run ended: steers whose target turn never ran get their reason. */
  onRunEnd(maxTurnReached: number): Promise<void>;
  /** Every steer's final record, keyed by target turn (transcript use). */
  recordsByTurn(): Map<number, SteerRecord[]>;
}

type SteerState = {
  record: SteerRecord;
  spec: SteerSpec;
  fired: boolean;
};

export function createSteerScheduler(options: {
  specs: SteerSpec[];
  session: AdapterSession;
  trace: AgentTaskTraceContext;
  /** Parent span id — the steer event nests under its turn's span. */
  turnSpanId?: (turnNumber: number) => string | undefined;
  onSteer?: (record: SteerRecord) => void;
}): SteerScheduler {
  const { specs, session, trace } = options;

  const states: SteerState[] = specs.map((spec, index) => ({
    spec,
    fired: false,
    record: {
      number: index + 1,
      turn: spec.turn ?? 1,
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      trigger: spec.when,
      message: spec.message,
      status: "undelivered",
    },
  }));

  // Per-turn progress counters, reset by onTurnStart.
  const toolResults = new Map<number, number>();
  const assistantReplies = new Map<number, number>();
  const activeTurns = new Set<number>();
  // Turns whose adapter emitted the mandatory { kind: "run_start" } event —
  // runStart steers fire on it, not in onTurnStart, because session.steer()
  // must only be called while the harness actually has a run to inject into.
  const runStartSeen = new Set<number>();
  // Turns that observed ANY progress event — distinguishes "trigger never
  // fired" (the run was too short) from "adapter never reported progress".
  const progressSeen = new Set<number>();

  // One serialized chain: every state transition appends to it, so events are
  // processed in arrival order and deliveries never interleave.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const next = chain.then(step, step);
    // The chain itself never rejects: step errors are captured inside each
    // step's own try/catch (a scheduler bug must not break the turn).
    chain = next.catch(() => {});
    return next;
  };

  function emitSteerEvent(record: SteerRecord): void {
    try {
      trace.recordEvent({
        step_name: TASK_STEER_SPAN_NAME,
        observation_type: "CHAIN",
        parent_call_id: options.turnSpanId?.(record.turn),
        metadata: {
          steerNumber: record.number,
          turn: record.turn,
          ...(record.label !== undefined ? { label: record.label } : {}),
          trigger: JSON.stringify(record.trigger),
          status: record.status,
          ...(record.boundary !== undefined ? { boundary: record.boundary } : {}),
          ...(record.reason !== undefined ? { reason: record.reason } : {}),
        },
        output: { ...record },
      });
    } catch {
      // A trace failure must never fail a steer delivery.
    }
  }

  function finalize(state: SteerState, reason: string): void {
    state.record.status = "undelivered";
    state.record.reason = reason;
    emitSteerEvent(state.record);
    options.onSteer?.(state.record);
  }

  async function deliver(state: SteerState, turnNumber: number): Promise<void> {
    state.fired = true;
    try {
      const result = await session.steer?.(state.spec.message, {
        trace,
        turnNumber,
        steerNumber: state.record.number,
      });
      state.record.status = "delivered";
      state.record.deliveredAt = new Date().toISOString();
      state.record.boundary = result?.boundary ?? "tool_results";
    } catch (error) {
      state.record.status = "error";
      state.record.reason = error instanceof Error ? error.message : String(error);
    }
    emitSteerEvent(state.record);
    options.onSteer?.(state.record);
  }

  function triggerSatisfied(trigger: SteerTrigger, turnNumber: number): boolean {
    if (trigger === "runStart") return runStartSeen.has(turnNumber);
    if ("toolResults" in trigger) {
      return (toolResults.get(turnNumber) ?? 0) >= trigger.toolResults;
    }
    return (assistantReplies.get(turnNumber) ?? 0) >= trigger.assistantReply;
  }

  return {
    onTurnStart(turnNumber) {
      return enqueue(async () => {
        toolResults.set(turnNumber, 0);
        assistantReplies.set(turnNumber, 0);
        activeTurns.add(turnNumber);
      });
    },

    onProgressEvent(turnNumber, event) {
      return enqueue(async () => {
        if (!activeTurns.has(turnNumber)) return;
        progressSeen.add(turnNumber);
        if (event.kind === "run_start") {
          runStartSeen.add(turnNumber);
        } else if (event.kind === "tool_result") {
          toolResults.set(turnNumber, (toolResults.get(turnNumber) ?? 0) + 1);
        } else if (event.kind === "assistant_reply") {
          assistantReplies.set(turnNumber, (assistantReplies.get(turnNumber) ?? 0) + 1);
        }
        for (const state of states) {
          if (state.fired || state.record.turn !== turnNumber) continue;
          if (triggerSatisfied(state.spec.when, turnNumber)) {
            await deliver(state, turnNumber);
          }
        }
      });
    },

    onTurnEnd(turnNumber) {
      return enqueue(async () => {
        activeTurns.delete(turnNumber);
        const reason = progressSeen.has(turnNumber)
          ? "turn ended before trigger fired"
          : "no progress events observed for this turn (adapter did not call notifyAgentEvent)";
        for (const state of states) {
          if (state.fired || state.record.turn !== turnNumber) continue;
          finalize(state, reason);
        }
      });
    },

    onRunEnd(maxTurnReached) {
      return enqueue(async () => {
        for (const state of states) {
          if (state.fired || state.record.status !== "undelivered") continue;
          if (state.record.turn > maxTurnReached) {
            finalize(state, "target turn never ran");
          }
        }
      });
    },

    recordsByTurn() {
      const byTurn = new Map<number, SteerRecord[]>();
      for (const state of states) {
        const list = byTurn.get(state.record.turn) ?? [];
        list.push(state.record);
        byTurn.set(state.record.turn, list);
      }
      return byTurn;
    },
  };
}
