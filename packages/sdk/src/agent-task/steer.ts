/**
 * Mid-run steering registration — the task-plane half of steering.
 *
 * `steer({...})` is called at eval-file top level next to `turn()`: it
 * declares that a user message will be injected into a turn that is already
 * running, at a boundary described relative to that turn's progress (after
 * its n-th tool result, its n-th assistant reply, or right at run start).
 *
 * Registration mechanics mirror `turn.ts`: a module-global array under a
 * `Symbol.for` key so the registry survives the eval module being imported
 * from a temp path, reset by `loadTask` before each import and read by the
 * runner's turn loop afterwards.
 */

export type SteerTrigger =
  /** After the n-th completed tool result of the target turn (1-based). */
  | { toolResults: number }
  /** After the n-th completed assistant message of the target turn (1-based). */
  | { assistantReply: number }
  /** Immediately after the turn's user input is handed to the agent. */
  | "runStart";

/** One scripted steer, registered from the eval file (or legacy checks.ts). */
export type SteerSpec = {
  when: SteerTrigger;
  /** The injected user message — same shape a `turn()` return value has. */
  message: unknown;
  /** Human label shown in the trace, transcript, and check failures. */
  label?: string;
  /** 1-based scripted turn this steer belongs to. Default 1. */
  turn?: number;
};

const STEERS_KEY = Symbol.for("@apo-ai/sdk/agent-task/task-steers");

/** Register a mid-run steer. Call at eval-file top level, next to turn(). */
export function steer(spec: SteerSpec): void {
  // Fail fast at registration: a trigger that can never fire (turn 0,
  // non-positive counts) would otherwise sit silently undelivered — the run
  // finishes with no `task.steer` evidence that anything was scheduled.
  if (spec.turn !== undefined && (!Number.isInteger(spec.turn) || spec.turn < 1)) {
    throw new Error(`steer: turn must be a positive integer, got ${spec.turn}`);
  }
  const count =
    spec.when === "runStart"
      ? undefined
      : "toolResults" in spec.when
        ? (["toolResults", spec.when.toolResults] as const)
        : (["assistantReply", spec.when.assistantReply] as const);
  if (count !== undefined && (!Number.isInteger(count[1]) || count[1] < 1)) {
    throw new Error(`steer: ${count[0]} must be a positive integer, got ${count[1]}`);
  }
  const registry = (globalThis as Record<symbol, unknown>)[STEERS_KEY];
  const list = Array.isArray(registry) ? (registry as SteerSpec[]) : [];
  list.push(spec);
  (globalThis as Record<symbol, unknown>)[STEERS_KEY] = list;
}

/** All steers registered so far, in registration order (runner use). */
export function getTaskSteers(): SteerSpec[] {
  const registry = (globalThis as Record<symbol, unknown>)[STEERS_KEY];
  return Array.isArray(registry) ? [...(registry as SteerSpec[])] : [];
}

/** Clear registrations (loadTask use — mirrors resetTaskTurn). */
export function resetTaskSteers(): void {
  delete (globalThis as Record<symbol, unknown>)[STEERS_KEY];
}
