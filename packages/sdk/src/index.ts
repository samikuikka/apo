/**
 * @apo/sdk — public entry point.
 *
 * The canonical tracing path is OpenTelemetry via `@apo/sdk/otel`.
 * The old TraceTracker custom protocol has been removed (SPEC-129 complete).
 */

export type {
  CreateTraceParams,
  CreateSpanParams,
  EndSpanParams,
  TraceRunContext,
  TraceRunOptions,
  TraceStepOptions,
  TraceEventOptions,
  IngestionEvent,
  CreateScoreParams,
  ClientOptions,
  ParameterOverrides,
  ObserveOptions,
  ObservationContext,
} from "./types";
export {
  ClientError,
  ConfigurationError,
  type ClientErrorCode,
} from "./errors";
export {
  readConfig,
  type EnvConfig,
} from "./config";
