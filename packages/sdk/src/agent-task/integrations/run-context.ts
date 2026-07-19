/**
 * Per-run context propagation via Node's AsyncLocalStorage.
 *
 * The OTel {@link ApoSpanProcessor} is global — it doesn't know which run a
 * span belongs to. This module solves that: {@link withApoRun} establishes
 * the run's trace context on AsyncLocalStorage, and any code called during
 * the run (including the processor's `onStart`/`onEnd`) can read it via
 * {@link getActiveApoRun}.
 *
 * This is the same propagation mechanism OTel's own
 * `AsyncLocalStorageContextManager` uses under the hood.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTaskTraceContext } from "../tracing.ts";

export interface ApoRunContext {
  /** The tee'd trace context for this run. */
  trace: AgentTaskTraceContext;
  /** The parent span id (the run's root span or the current turn span). */
  parentSpanId?: string;
  /** The task id, surfaced in span metadata. */
  taskId?: string;
  /** The current turn number, surfaced in span metadata. */
  turnNumber?: number;
}

const runStorage = new AsyncLocalStorage<ApoRunContext>();

/**
 * Run `fn` with `ctx` as the active apo run context. Any code inside `fn`
 * (including across `await` boundaries) can call {@link getActiveApoRun}
 * to retrieve it.
 */
export function withApoRun<T>(ctx: ApoRunContext, fn: () => Promise<T>): Promise<T> {
  return runStorage.run(ctx, fn);
}

/**
 * Run `fn` synchronously with `ctx` as the active apo run context.
 */
export function withApoRunSync<T>(ctx: ApoRunContext, fn: () => T): T {
  return runStorage.run(ctx, fn);
}

/**
 * Get the active run context, or `undefined` if called outside a run.
 *
 * This is what the {@link ApoSpanProcessor} calls in `onStart`/`onEnd` to
 * know which run a span belongs to.
 */
export function getActiveApoRun(): ApoRunContext | undefined {
  return runStorage.getStore();
}
