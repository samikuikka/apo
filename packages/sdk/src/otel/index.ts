/**
 * OTel-native tracing setup for the apo SDK (SPEC-129 Track 4).
 *
 * This module provides the standard OpenTelemetry setup path for apo:
 *   - ``configureApoTelemetry`` creates a tracer provider with an OTLP exporter
 *   - ``withApoTrace`` creates root/child spans using standard OTel context
 *   - Helper functions (``traceTool``, ``traceAgent``, etc.) emit normal OTel
 *     spans with GenAI or apo vendor attributes
 *
 * This replaces the deprecated ``TraceTracker`` custom event protocol. New
 * users should use this module; existing ``TraceTracker`` code continues to
 * work through a compatibility bridge.
 *
 * @module @apo/sdk/otel
 */

import {
  trace,
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Span,
  type Tracer,
  type SpanOptions,
  type TracerProvider,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

/**
 * Shared W3C Trace Context propagator. OTel's official implementation handles
 * `traceparent`/`tracestate`, edge cases (invalid traceId/spanId, versioning),
 * and stays correct as the spec evolves — so we delegate to it instead of
 * hand-rolling `00-<trace>-<span>-<flags>` parsing.
 */
const w3cPropagator = new W3CTraceContextPropagator();
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_SERVICE_NAMESPACE,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getRegisteredApoProcessor } from "../agent-task/integrations/register.ts";

// ── public types (SPEC-129 §6) ───────────────────────────────────────────

export interface ConfigureApoTelemetryOptions {
  /** Explicit permission for this standalone helper to own OTel lifecycle. */
  takeOwnership: true;
  /**
   * Full OTLP traces endpoint URL. Falls back to the `APO_OTLP_ENDPOINT` env
   * var when omitted, then to `http://localhost:8000/api/public/otel/v1/traces`.
   */
  endpoint?: string;
  /**
   * Diagnostic resource attribute only. Auth owns tenancy — the project is
   * determined by the API key / service token, never by this field.
   * Falls back to the `APO_PROJECT` env var when omitted.
   */
  project?: string;
  /**
   * Service name for the OTel resource (required). Defaults to `"apo-agent"`.
   */
  serviceName?: string;
  /** Service version for the OTel resource. */
  serviceVersion?: string;
  /** Deployment environment (production, staging, etc.). */
  environment?: string;
  /**
   * Auth headers (Authorization: Basic/Bearer). Falls back to headers derived
   * from `APO_PUBLIC_KEY`+`APO_SECRET_KEY` (Basic) or `APO_AUTH_TOKEN` (Bearer)
   * env vars when omitted. Use {@link buildApoAuthHeaders} to build them
   * explicitly.
   */
  headers?: Record<string, string>;
  /**
   * Public key for Basic auth. Falls back to `APO_PUBLIC_KEY` env var.
   * Used with `secretKey` to build `Authorization: Basic base64(pk:sk)`.
   */
  publicKey?: string;
  /**
   * Secret key for Basic auth. Falls back to `APO_SECRET_KEY` env var.
   */
  secretKey?: string;
  /**
   * Bearer auth token. Falls back to `APO_AUTH_TOKEN` env var. Used only when
   * `publicKey`/`secretKey` are absent.
   */
  authToken?: string;
  /**
   * @deprecated OTel JS 2.x providers cannot accept processors after
   * construction. Use `createApoSpanProcessor()` in the host provider's
   * `spanProcessors` array instead.
   */
  provider?: TracerProvider;
  /** Batch for services; simple is useful for short-lived task subprocesses. */
  processor?: "batch" | "simple";
  /**
   * Whether to register apo's provider as the global tracer provider. Defaults
   * to false. When true, registration only happens if no global provider is
   * registered yet — apo never silently replaces an existing global provider.
   */
  registerGlobal?: boolean;
}

export interface ApoTelemetryHandle {
  /** The OTel tracer for creating spans. */
  tracer: Tracer;
  /** The provider, for advanced use. */
  provider: TracerProvider;
  /** Export all ended spans without relinquishing provider ownership. */
  forceFlush(): Promise<void>;
  /** Gracefully shut down the provider and flush pending spans. */
  shutdown(): Promise<void>;
}

export interface ApoTraceExporterOptions {
  /** Full standard OTLP/HTTP traces endpoint. */
  endpoint: string;
  /** Authentication headers sent by the official OTLP exporter. */
  headers: Record<string, string>;
}

export interface ApoSpanProcessorOptions extends ApoTraceExporterOptions {
  /** Batch for long-lived services (default), simple for short-lived jobs. */
  processor?: "batch" | "simple";
}

export interface ApoTraceOptions {
  /** Span name. */
  name: string;
  /** apo.observation.type override. */
  observationType?: string;
  /** Additional attributes. */
  attributes?: Record<string, unknown>;
}

interface OwnedContextState {
  manager: AsyncHooksContextManager;
  references: number;
}

let ownedContext: OwnedContextState | null = null;

/** Create the official OTLP/HTTP exporter for a host-owned OTel provider. */
export function createApoTraceExporter(
  options: ApoTraceExporterOptions,
): SpanExporter {
  return new OTLPTraceExporter({
    url: options.endpoint,
    headers: options.headers,
  });
}

/**
 * Create an apo OTLP processor for inclusion when constructing a host provider.
 * This factory has no global side effects and transfers lifecycle ownership to
 * the host provider.
 */
export function createApoSpanProcessor(
  options: ApoSpanProcessorOptions,
): SpanProcessor {
  const exporter = createApoTraceExporter(options);
  return options.processor === "simple"
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);
}

// ── auth + env-var helpers (mirror apo-otel-python) ─────────────────────

const DEFAULT_APO_OTLP_ENDPOINT = "http://localhost:8000/api/public/otel/v1/traces";

/**
 * Build the `Authorization` header for apo's OTLP endpoint.
 *
 * - If `publicKey` + `secretKey` are given (or read from `APO_PUBLIC_KEY` /
 *   `APO_SECRET_KEY`), returns HTTP Basic: `Basic base64(pk:sk)`.
 * - Else if `authToken` is given (or read from `APO_AUTH_TOKEN`), returns
 *   `Bearer <token>`.
 * - Else returns an empty object (unauthenticated).
 *
 * Mirrors Python's `_build_auth_headers` in apo-otel-python.
 */
export function buildApoAuthHeaders(
  publicKey?: string,
  secretKey?: string,
  authToken?: string,
): Record<string, string> {
  const pk = publicKey ?? process.env.APO_PUBLIC_KEY;
  const sk = secretKey ?? process.env.APO_SECRET_KEY;
  const token = authToken ?? process.env.APO_AUTH_TOKEN;
  if (pk && sk) {
    const credentials = typeof btoa === "function"
      ? btoa(`${pk}:${sk}`)
      : Buffer.from(`${pk}:${sk}`).toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

/**
 * Resolve telemetry config: explicit kwarg wins, else env var, else default.
 * Mirrors Python's `_resolve_standalone_configuration`.
 */
function resolveTelemetryConfig(options: ConfigureApoTelemetryOptions): {
  endpoint: string;
  headers: Record<string, string>;
  project: string | undefined;
  serviceName: string;
} {
  const endpoint = options.endpoint
    ?? process.env.APO_OTLP_ENDPOINT
    ?? DEFAULT_APO_OTLP_ENDPOINT;
  const project = options.project ?? process.env.APO_PROJECT;
  const serviceName = options.serviceName ?? "apo-agent";
  const headers = options.headers
    ?? buildApoAuthHeaders(options.publicKey, options.secretKey, options.authToken);
  return { endpoint, headers, project, serviceName };
}

/**
 * Set the GenAI content-capture env var so instrumentation libs emit prompt
 * and completion text into spans. Uses `setdefault`-equivalent semantics: an
 * explicit user setting is never overridden. Mirrors Python's
 * `_configure_instrumentation_environment`.
 */
function configureInstrumentationEnvironment(): void {
  if (!process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT) {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "span_only";
  }
}

// ── configureApoTelemetry ────────────────────────────────────────────────

/**
 * Configure apo's OpenTelemetry tracing.
 *
 * Builds apo's trace export from official OTel components: a real
 * {@link Resource} (service.name, service.version, deployment.environment)
 * and the official {@link OTLPTraceExporter} (standard OTLP/HTTP, no custom
 * wire format). This is the explicit standalone bootstrap. Host applications
 * that already own a provider should use `createApoSpanProcessor()` instead.
 *
 * @example
 * ```ts
 * import { configureApoTelemetry } from "@apo/sdk/otel";
 *
 * const apo = await configureApoTelemetry({
 *   takeOwnership: true,
 *   endpoint: "https://apo.example.com/api/public/otel/v1/traces",
 *   serviceName: "my-agent",
 *   headers: { Authorization: `Basic ${btoa("pk-apo-...:sk-apo-...")}` },
 * });
 *
 * const result = await withApoTrace({ name: "chat" }, apo.tracer, async (span) => {
 *   span.setAttribute("gen_ai.request.model", "gpt-4o");
 *   // ... do work ...
 *   return "done";
 * });
 *
 * await apo.shutdown();
 * ```
 */
export async function configureApoTelemetry(
  options: ConfigureApoTelemetryOptions,
): Promise<ApoTelemetryHandle> {
  if (options.takeOwnership !== true) {
    throw new TypeError("standalone bootstrap requires takeOwnership: true");
  }
  if (options.provider !== undefined) {
    throw new TypeError(
      "A host provider cannot be mutated after construction in OTel JS 2.x; " +
      "construct it with createApoSpanProcessor() instead.",
    );
  }

  // Resolve config from kwargs → env vars → defaults (mirror apo-otel-python).
  const { endpoint, headers, project, serviceName } = resolveTelemetryConfig(options);

  // Enable prompt/completion content capture for instrumentation libs.
  configureInstrumentationEnvironment();

  // Set up the async context manager so context.active() carries the active
  // span. Concurrent apo handles share one owned manager; a host-owned manager
  // is used as-is and is never disabled by apo.
  const releaseContext = acquireContextManager();

  // Build the official OTel Resource with standard semantic attributes.
  const resourceAttrs: Record<string, string> = {
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
  };
  if (project) resourceAttrs[SEMRESATTRS_SERVICE_NAMESPACE] = project;
  if (options.serviceVersion) resourceAttrs[SEMRESATTRS_SERVICE_VERSION] = options.serviceVersion;
  if (options.environment) resourceAttrs[SEMRESATTRS_DEPLOYMENT_ENVIRONMENT] = options.environment;
  const resource = resourceFromAttributes(resourceAttrs);

  // Official OTLP/HTTP trace exporter — standard OTLP wire format, no custom
  // serializer. Headers carry the auth the apo receiver validates.
  // The standalone path owns this provider. Host-owned providers compose with
  // createApoSpanProcessor() at their own construction boundary.
  const spanProcessors: SpanProcessor[] = [createApoSpanProcessor({
    endpoint,
    headers,
    processor: options.processor,
  })];

  // If an ApoSpanProcessor was registered via registerApoTracing(), add it to
  // this provider so GenAI spans from SDKs (Vercel AI, OpenAI, etc.) are fed
  // into the projection-tee for local assertions AND exported via OTLP.
  const apoProcessor = getRegisteredApoProcessor();
  if (apoProcessor) {
    spanProcessors.push(apoProcessor as unknown as SpanProcessor);
  }

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors,
  });

  const tracer = provider.getTracer("apo-sdk", "0.2.0");

  // Register globally only when explicitly requested AND no host provider was
  // supplied AND no global provider is registered yet. apo never silently
  // replaces a host/global provider.
  let registeredGlobal = false;
  if (options.registerGlobal) {
    registeredGlobal = trace.setGlobalTracerProvider(provider);
  }

  let stopped = false;

  return {
    tracer,
    provider,
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      // Force-flush + shut down the provider, but bound the whole teardown so
      // an unreachable export endpoint (e.g. no backend in unit tests) never
      // hangs the process. The span processors/exporters swallow their own
      // transport errors; this guards against the wait itself.
      await Promise.race([
        (async () => {
          await provider.forceFlush().catch(() => undefined);
          await provider.shutdown().catch(() => undefined);
        })(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      // Reset global state so a later configuration starts clean.
      if (registeredGlobal) {
        trace.disable();
      }
      releaseContext();
    },
  };
}

function acquireContextManager(): () => void {
  if (ownedContext !== null) {
    ownedContext.references += 1;
    const acquired = ownedContext;
    return () => releaseOwnedContext(acquired);
  }

  const manager = new AsyncHooksContextManager().enable();
  if (!context.setGlobalContextManager(manager)) {
    manager.disable();
    return () => undefined;
  }

  const acquired: OwnedContextState = { manager, references: 1 };
  ownedContext = acquired;
  return () => releaseOwnedContext(acquired);
}

function releaseOwnedContext(acquired: OwnedContextState): void {
  if (ownedContext !== acquired) return;
  acquired.references -= 1;
  if (acquired.references > 0) return;
  context.disable();
  ownedContext = null;
}

// ── withApoTrace ─────────────────────────────────────────────────────────

/**
 * Run a function inside an OTel span.
 *
 * Creates a span using the active OTel context (standard context propagation,
 * not apo-specific span IDs passed by hand). The span automatically ends when
 * the function returns or throws.
 *
 * @example
 * ```ts
 * const result = await withApoTrace(
 *   { name: "agent-turn", observationType: "AGENT" },
 *   apo.tracer,
 *   async (span) => {
 *     span.setAttribute("gen_ai.request.model", "gpt-4o");
 *     return await llm.complete("hello");
 *   },
 * );
 * ```
 */
export async function withApoTrace<T>(
  options: ApoTraceOptions,
  tracer: Tracer,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const spanOptions: SpanOptions = {};
  if (options.attributes) {
    spanOptions.attributes = options.attributes as Record<string, string | number | boolean>;
  }

  // Use startActiveSpan which creates the span AND activates it in context,
  // so nested withApoTrace calls automatically inherit it as parent.
  return new Promise<T>((resolve, reject) => {
    tracer.startActiveSpan(options.name, spanOptions, async (span: Span) => {
      // Set apo vendor attributes
      if (options.observationType) {
        span.setAttribute("apo.observation.type", options.observationType);
      }

      try {
        const result = await fn(span);
        span.end();
        resolve(result);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
        span.end();
        reject(err);
      }
    });
  });
}

// ── helper functions ─────────────────────────────────────────────────────

/**
 * Trace a tool execution as an OTel span.
 *
 * Creates a span with ``gen_ai.tool.name``, ``gen_ai.tool.call.arguments``,
 * and ``gen_ai.tool.call.result`` attributes so the backend normalizer
 * classifies it as a TOOL observation.
 */
export async function traceTool<T>(
  tracer: Tracer,
  name: string,
  params: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  return withApoTrace(
    {
      name: `tool ${name}`,
      observationType: "TOOL",
      attributes: {
        "gen_ai.tool.name": name,
        "gen_ai.tool.call.arguments": JSON.stringify(params),
      },
    },
    tracer,
    async (span) => {
      const result = await fn();
      span.setAttribute("gen_ai.tool.call.result", JSON.stringify(result));
      return result;
    },
  );
}

/**
 * Trace an agent invocation as an OTel span.
 */
export async function traceAgent<T>(
  tracer: Tracer,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withApoTrace(
    { name, observationType: "AGENT" },
    tracer,
    async () => fn(),
  );
}

/**
 * Trace a chain/step as an OTel span.
 */
export async function traceChain<T>(
  tracer: Tracer,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withApoTrace(
    { name, observationType: "CHAIN" },
    tracer,
    async () => fn(),
  );
}

/**
 * Trace a retrieval as an OTel span.
 */
export async function traceRetriever<T>(
  tracer: Tracer,
  query: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withApoTrace(
    { name: "retrieve", observationType: "RETRIEVER", attributes: { query } },
    tracer,
    async () => fn(),
  );
}

// ── Score API (SPEC-129 §5: Scores are domain records, not spans) ─────────

export interface ScoreOptions {
  name: string;
  value: number | string | boolean;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  source?: "API" | "EVAL" | "ANNOTATION";
  comment?: string;
  observationId?: string;
}

/**
 * Record a score for a trace (or a specific observation within a trace).
 *
 * SPEC-129 §5: "A Score is an apo domain record attached to a Trace or
 * Observation. It is not encoded as a fake span."
 *
 * This calls the native score API (`POST /api/v1/traces/{id}/scores` or
 * `POST /api/v1/observations/{id}/scores`) instead of creating a sentinel
 * span. The score is stored as a `RunMetricDB` or `CallMetricDB` row.
 *
 * @example
 * ```ts
 * await score({
 *   traceId: "abc123...",
 *   name: "helpfulness",
 *   value: 0.85,
 *   dataType: "NUMERIC",
 *   source: "EVAL",
 * }, { endpoint: "http://localhost:8000", headers: authHeaders });
 * ```
 */
export async function score(
  params: ScoreOptions & { traceId: string },
  config: { endpoint: string; headers: Record<string, string> },
): Promise<void> {
  const url = params.observationId
    ? `${config.endpoint}/api/v1/observations/${params.observationId}/scores`
    : `${config.endpoint}/api/v1/traces/${params.traceId}/scores`;

  const body: Record<string, unknown> = {
    name: params.name,
    value: params.value,
    data_type: params.dataType ?? "NUMERIC",
    source: params.source ?? "API",
  };
  if (params.comment) body.comment = params.comment;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...config.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[apo score] HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.error("[apo score] failed:", err);
  }
}

// ── W3C trace context propagation (SPEC-129 Test Case #10) ───────────────

/**
 * Inject the current span's trace context into a headers dict for outbound
 * HTTP/queue calls. Produces a standard W3C `traceparent` header so the
 * downstream service can extract it and create a child span in the same trace.
 *
 * Delegates to OTel's official `W3CTraceContextPropagator`, which also emits
 * `tracestate` and handles the spec's edge cases.
 *
 * @example
 * ```ts
 * const headers = injectTraceparent();
 * await fetch("http://downstream-service/api", { headers });
 * ```
 */
export function injectTraceparent(): Record<string, string> {
  const carrier: Record<string, string> = {};
  w3cPropagator.inject(context.active(), carrier, defaultTextMapSetter);
  return carrier;
}

/**
 * Extract a W3C trace context from inbound headers and run a function as a
 * child span within that trace. If no `traceparent` header is present (or it
 * is malformed), a new root span is created.
 *
 * Transport parsing is delegated to OTel's `W3CTraceContextPropagator`; the
 * span creation on top of the extracted remote parent is apo-specific and
 * kept here.
 *
 * @example
 * ```ts
 * // In a downstream HTTP handler:
 * app.post("/api", (req, res) => {
 *   const result = await extractTraceparent(req.headers, tracer, async (span) => {
 *     return await doWork();
 *   });
 *   res.json(result);
 * });
 * ```
 */
export async function extractTraceparent<T>(
  headers: Record<string, string>,
  tracer: Tracer,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  // Extract the upstream context. The propagator handles invalid/missing
  // traceparent by returning the input context unchanged (no extracted span).
  const extracted = w3cPropagator.extract(context.active(), headers, defaultTextMapGetter);
  const parent = trace.getSpan(extracted);
  if (!parent) {
    // No upstream context → new root span
    return withApoTrace({ name: "inbound" }, tracer, fn);
  }

  // Create a child span in the extracted context (shares the upstream traceId).
  return new Promise<T>((resolve, reject) => {
    context.with(extracted, () => {
      tracer.startActiveSpan("inbound", async (span: Span) => {
        try {
          const result = await fn(span);
          span.end();
          resolve(result);
        } catch (err) {
          span.recordException(err as Error);
          span.end();
          reject(err);
        }
      });
    });
  });
}
