/**
 * Build the environment for the Claude Agent SDK subprocess.
 *
 * The SDK emits OpenTelemetry natively. It reads three standard OTLP env
 * vars to decide where to export its spans, plus a W3C `TRACEPARENT` env var
 * to link its spans under the active span's trace. This module sets all four
 * on the subprocess env — extracted from `claude-adapter.ts` so the adapter
 * shows only apo's lifecycle contract.
 *
 * MUST be called inside `sendUserTurn` while the active OTel span
 * (`task.turn`) is on the context — `injectTraceparent()` reads it.
 */
import { injectTraceparent } from "@apo/sdk/otel";

/** Build the OTLP export endpoint for the apo backend's OTel receiver. */
export function otelEndpoint(): string {
  // AGENT_TASK_TRACE_ENDPOINT is the base apo URL the runtime already uses to
  // ship its own spans. Append the OTel receiver path.
  const base = process.env.AGENT_TASK_TRACE_ENDPOINT ?? "http://127.0.0.1:8000";
  return `${base}/api/public/otel`;
}

/**
 * Build the env for the Claude Agent SDK subprocess.
 *
 * The SDK REPLACES process.env with whatever `env` we pass — it does not
 * merge. So we start from the inherited environment (the subprocess needs
 * PATH, HOME, and ANTHROPIC_API_KEY/AUTH_TOKEN to reach the model) and layer
 * the OTel vars on top.
 */
export function buildOtelEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  env.OTEL_EXPORTER_OTLP_ENDPOINT = otelEndpoint();
  // The Claude Agent SDK subprocess emits OTLP/HTTP JSON. (Protobuf also works;
  // JSON is simpler to inspect and matches the backend's JSON receiver path.)
  env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  env.OTEL_TRACES_EXPORTER = "otlp";
  env.OTEL_METRICS_EXPORTER = "none";
  env.OTEL_LOGS_EXPORTER = "none";
  env.OTEL_SERVICE_NAME = "apo-claude-agent";
  // Both flags are required for the subprocess to emit traces — without
  // CLAUDE_CODE_ENHANCED_TELEMETRY_BETA it exports metrics only, no spans.
  env.CLAUDE_CODE_ENABLE_TELEMETRY = "1";
  env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1";
  if (process.env.APO_AUTH_TOKEN) {
    env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${process.env.APO_AUTH_TOKEN}`;
  }
  // W3C traceparent — links the subprocess's spans under the active apo span.
  const carrier = injectTraceparent();
  if (carrier.traceparent) env.TRACEPARENT = carrier.traceparent;
  return env;
}
