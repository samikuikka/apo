export interface ApoConfig {
  backendUrl: string;
  apiKey: string | undefined;
  projectId: string | undefined;
}

export interface ApoOtlpImportResponse {
  acceptedSpans: number;
  rejectedSpans: number;
  batchId: string;
  errorMessage?: string;
}

export class ApoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApoAuthError";
  }
}

export class ApoVisibilityTimeoutError extends Error {
  readonly traceId: string;
  constructor(traceId: string, message: string) {
    super(message);
    this.name = "ApoVisibilityTimeoutError";
    this.traceId = traceId;
  }
}

type PollOptions = {
  totalDeadlineMs: number;
  intervalMs: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildOtlpUrl(backendUrl: string): string {
  return joinPath(backendUrl, "/api/public/otel/v1/traces");
}

export function buildTraceDetailUrl(
  backendUrl: string,
  traceId: string,
  projectId: string | undefined,
): URL {
  const url = new URL(joinPath(backendUrl, `/v1/runs/${encodeURIComponent(traceId)}`));
  if (projectId) url.searchParams.set("project", projectId);
  return url;
}

export async function parseOtlpResponse(
  response: Response,
): Promise<ApoOtlpImportResponse> {
  const accepted = parseHeaderInt(response.headers, "X-Otlp-Accepted");
  const rejected = parseHeaderInt(response.headers, "X-Otlp-Rejected");
  const batchId = response.headers.get("X-Otlp-Batch-Id") ?? "";

  let errorMessage: string | undefined;
  let bodyRejected = rejected;

  // Always attempt to parse the body — OTLP responses may carry a
  // partialSuccess shape without an explicit content-type, and protobuf
  // JSON encodings reuse the same surface. silentlyReadJson returns
  // undefined for non-JSON bodies.
  const body = await safelyReadJson(response);
  if (body && typeof body === "object") {
    const partial = (body as { partialSuccess?: unknown }).partialSuccess;
    if (partial && typeof partial === "object") {
      const p = partial as { errorMessage?: unknown; rejectedSpans?: unknown };
      if (typeof p.errorMessage === "string" && p.errorMessage.length > 0) {
        errorMessage = p.errorMessage;
      }
      if (rejected === 0 && typeof p.rejectedSpans === "number") {
        bodyRejected = p.rejectedSpans;
      }
    }
  }

  return {
    acceptedSpans: accepted,
    rejectedSpans: bodyRejected,
    batchId,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

export async function submitOtlpChunk(
  backendUrl: string,
  body: unknown,
  config: ApoConfig,
): Promise<ApoOtlpImportResponse> {
  const url = buildOtlpUrl(backendUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(config),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `OTLP request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s at ${url}`,
      );
    }
    throw new Error(`Cannot reach apo backend at ${backendUrl} for OTLP ingestion`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new ApoAuthError(
      "apo rejected the API key for OTLP ingestion. Run `apo login` or set APO_API_KEY.",
    );
  }
  if (!response.ok) {
    throw new Error(`apo OTLP ingestion failed (${response.status}) at ${url}`);
  }
  return parseOtlpResponse(response);
}

export async function pollTraceVisibility(
  backendUrl: string,
  traceId: string,
  config: ApoConfig,
  options: PollOptions,
): Promise<void> {
  const url = buildTraceDetailUrl(backendUrl, traceId, config.projectId);
  const deadline = Date.now() + options.totalDeadlineMs;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: authHeaders(config),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      await sleep(options.intervalMs);
      continue;
    } finally {
      clearTimeout(timeout);
    }
    lastStatus = response.status;
    if (response.status === 200) return;
    await sleep(options.intervalMs);
  }

  throw new ApoVisibilityTimeoutError(
    traceId,
    `apo accepted the OTLP writes but trace ${traceId} was still not readable after ${options.totalDeadlineMs}ms (last status ${lastStatus}). Projection may still be pending; check the durable inbox queue.`,
  );
}

function authHeaders(config: ApoConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

function joinPath(base: string, path: string): string {
  // Preserve any path prefix on baseUrl (proxy / same-origin routing).
  // `new URL(path, base)` would replace an existing prefix; we append instead.
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}

function parseHeaderInt(headers: Headers, name: string): number {
  const value = headers.get(name);
  if (value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function safelyReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
