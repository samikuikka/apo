import type { JsonValue, LangfuseObservation } from "./langfuse-otlp.ts";

export interface LangfuseConnectorConfig {
  host: string;
  publicKey: string;
  secretKey: string;
  maxObservations: number;
}

export interface LangfuseTraceGraph {
  sourceHost: string;
  sourceTraceId: string;
  observations: readonly LangfuseObservation[];
}

export const DEFAULT_MAX_OBSERVATIONS = 10_000;
const MIN_MAX_OBSERVATIONS = 1;
const MAX_MAX_OBSERVATIONS = 50_000;
const PAGE_LIMIT = 1000;
const PAGE_TIMEOUT_MS = 15_000;
const FIELD_GROUPS = [
  "core",
  "basic",
  "time",
  "io",
  "metadata",
  "model",
  "usage",
  "metrics",
  "trace_context",
].join(",");
const DEFAULT_HOST = "https://cloud.langfuse.com";

type ResolveOptions = {
  hostFlag?: string;
  maxObservationsFlag?: string;
};

export function resolveConnectorConfig(options: ResolveOptions = {}): LangfuseConnectorConfig {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY ?? "").trim();

  // Surface missing var names without echoing any value the user supplied.
  if (!publicKey && !secretKey) {
    throw new Error(
      "Missing required environment variables: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
    );
  }
  if (!publicKey) {
    throw new Error("Missing required environment variable: LANGFUSE_PUBLIC_KEY");
  }
  if (!secretKey) {
    throw new Error("Missing required environment variable: LANGFUSE_SECRET_KEY");
  }

  const hostInput = (options.hostFlag || process.env.LANGFUSE_HOST || DEFAULT_HOST).trim();
  const host = normalizeHost(hostInput);
  const maxObservations = resolveMaxObservations(options.maxObservationsFlag);

  return { host, publicKey, secretKey, maxObservations };
}

export async function fetchLangfuseTrace(
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
): Promise<LangfuseTraceGraph> {
  const rows: LangfuseObservation[] = [];
  let cursor: string | null = null;

  do {
    const page = await fetchObservationPage(sourceTraceId, cursor, config);
    for (const row of page.data) {
      if (rows.length >= config.maxObservations) {
        throw new Error(
          `Langfuse trace ${sourceTraceId} exceeded --max-observations ceiling (${config.maxObservations}); aborting before any apo write`,
        );
      }
      rows.push(validateObservation(row, sourceTraceId));
    }
    cursor = page.meta.cursor ?? null;
  } while (cursor !== null);

  if (rows.length === 0) {
    throw new Error(
      `Langfuse returned no observations for source trace ${sourceTraceId}`,
    );
  }
  if (rows.length > config.maxObservations) {
    throw new Error(
      `Langfuse trace ${sourceTraceId} exceeded --max-observations ceiling (${config.maxObservations}); aborting before any apo write`,
    );
  }

  return {
    sourceHost: config.host,
    sourceTraceId,
    observations: rows,
  };
}

type LangfuseObservationPage = {
  data: LangfuseObservation[];
  meta: { cursor?: string | null };
};

async function fetchObservationPage(
  sourceTraceId: string,
  cursor: string | null,
  config: LangfuseConnectorConfig,
): Promise<LangfuseObservationPage> {
  const url = buildObservationsUrl(config.host, sourceTraceId, cursor);
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Langfuse request timed out after ${PAGE_TIMEOUT_MS / 1000}s for source trace ${sourceTraceId}`,
      );
    }
    throw new Error(
      `Cannot reach Langfuse at ${config.host} for source trace ${sourceTraceId}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Langfuse authentication failed (${response.status}): credentials rejected for source trace ${sourceTraceId}. Check LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY and that the keys belong to the right Langfuse project.`,
    );
  }
  if (response.status === 404) {
    throw new Error(
      `Langfuse returned 404 for source trace ${sourceTraceId}`,
    );
  }
  if (response.status === 429) {
    throw new Error(
      `Langfuse rate-limited the request for source trace ${sourceTraceId}; safe to retry after backoff`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Langfuse request failed (${response.status}) for source trace ${sourceTraceId} at ${config.host}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(
      `Langfuse returned a non-JSON response for source trace ${sourceTraceId}`,
    );
  }
  return validateObservationPage(parsed, sourceTraceId);
}

function buildObservationsUrl(
  host: string,
  sourceTraceId: string,
  cursor: string | null,
): URL {
  const url = new URL("/api/public/v2/observations", host);
  url.searchParams.set("traceId", sourceTraceId);
  url.searchParams.set("fields", FIELD_GROUPS);
  url.searchParams.set("parseIoAsJson", "true");
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

function validateObservationPage(
  parsed: unknown,
  sourceTraceId: string,
): LangfuseObservationPage {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Langfuse response for source trace ${sourceTraceId} was not an object`,
    );
  }
  const obj = parsed as { data?: unknown; meta?: unknown };
  if (!Array.isArray(obj.data)) {
    throw new Error(
      `Langfuse response for source trace ${sourceTraceId} is missing a 'data' array`,
    );
  }
  const meta = (obj.meta ?? {}) as { cursor?: string | null };
  return { data: obj.data as LangfuseObservation[], meta };
}

function validateObservation(
  row: unknown,
  sourceTraceId: string,
): LangfuseObservation {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(
      `Langfuse returned a non-object observation row for source trace ${sourceTraceId}`,
    );
  }
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.traceId !== "string" || typeof r.type !== "string") {
    throw new Error(
      `Langfuse observation for source trace ${sourceTraceId} is missing core fields (id/traceId/type)`,
    );
  }
  if (r.traceId !== sourceTraceId) {
    throw new Error(
      `Langfuse observation ${r.id} traceId (${r.traceId}) does not match requested source trace ${sourceTraceId}`,
    );
  }
  return row as LangfuseObservation;
}

function normalizeHost(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid LANGFUSE_HOST URL: ${redact(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `LANGFUSE_HOST must be http(s); got scheme ${url.protocol.replace(":", "")}`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      "LANGFUSE_HOST must not contain embedded credentials",
    );
  }
  // Origin-only: drop path/query/fragment. Lowercase scheme + host.
  return `${url.protocol}//${url.host}`;
}

function resolveMaxObservations(flag: string | undefined): number {
  if (!flag) return DEFAULT_MAX_OBSERVATIONS;
  const n = Number(flag);
  if (!Number.isInteger(n) || n < MIN_MAX_OBSERVATIONS || n > MAX_MAX_OBSERVATIONS) {
    throw new Error(
      `--max-observations must be an integer in ${MIN_MAX_OBSERVATIONS}..${MAX_MAX_OBSERVATIONS}; got ${redact(flag)}`,
    );
  }
  return n;
}

function redact(value: string): string {
  // Never echo back a value that might be a secret in disguise.
  if (value.length > 32) return value.slice(0, 8) + "...(redacted)";
  return value.replace(/[\w-]{8,}/g, "(redacted)");
}

export type { JsonValue };
