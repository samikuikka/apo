/**
 * Registration API for the OTel-native tracing integration.
 *
 * Call {@link registerApoTracing} once at startup (e.g., in `startSession`
 * or at module load). After this, any SDK that emits OTel spans during a run
 * will be traced automatically — no per-SDK wrapper needed.
 *
 * @example
 * ```ts
 * import { registerApoTracing } from "@apo/sdk/agent-task";
 *
 * async startSession(ctx) {
 *   registerApoTracing(); // one line, once
 *   return { async sendUserTurn(turn) { ... } };
 * }
 * ```
 *
 * @module
 */

import { ApoSpanProcessor } from "./otel-processor.ts";

// We use dynamic imports for @opentelemetry so the module is importable
// without the packages installed. In practice they're transitive deps of `ai`.

let registered = false;
let currentProcessor: ApoSpanProcessor | null = null;

export interface RegisterApoTracingOptions {
  /**
   * Set as the global tracer provider (default: true).
   * Set to false if the host app has its own OTel setup and you want to
   * add apo's processor to an existing provider instead.
   */
  setGlobal?: boolean;
}

/**
 * Register apo's OTel SpanProcessor. Idempotent — calling it more than
 * once is a no-op.
 *
 * After registration, any OTel span created during an apo run (inside
 * `withApoRun`) that matches the GenAI conventions (`ai.*` or `gen_ai.*`)
 * is automatically translated and fed into the run's Flow.
 */
export async function registerApoTracing(
  _options?: RegisterApoTracingOptions,
): Promise<void> {
  if (registered) return;
  registered = true;

  // Create the processor but DON'T register our own provider. The processor
  // is picked up by configureApoTelemetry (via getRegisteredApoProcessor)
  // and added to the OTLP-exporting provider. This ensures GenAI spans from
  // SDKs (Vercel AI, OpenAI, etc.) reach BOTH the projection-tee (for local
  // assertions) AND the OTLP exporter (for the backend), all through a single
  // global provider — no competing providers.
  currentProcessor = new ApoSpanProcessor();
}

/**
 * Get the registered processor (for testing or advanced use).
 * Returns null if `registerApoTracing` hasn't been called.
 */
export function getApoProcessor(): ApoSpanProcessor | null {
  return currentProcessor;
}

/**
 * Alias used by configureApoTelemetry to pick up the processor and add it
 * to the OTLP-exporting provider.
 */
export function getRegisteredApoProcessor(): ApoSpanProcessor | null {
  return currentProcessor;
}

/**
 * Reset registration state — for testing only.
 */
export function resetApoTracing(): void {
  registered = false;
  currentProcessor = null;
}
