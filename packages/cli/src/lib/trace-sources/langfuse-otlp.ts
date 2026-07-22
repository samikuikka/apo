import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface LangfuseObservation {
  id: string;
  traceId: string;
  parentObservationId?: string | null;
  type: string;
  startTime: string;
  endTime?: string | null;
  name?: string | null;
  level?: string | null;
  statusMessage?: string | null;
  input?: JsonValue;
  output?: JsonValue;
  metadata?: JsonValue;
  providedModelName?: string | null;
  usageDetails?: Readonly<Record<string, number>> | null;
  costDetails?: Readonly<Record<string, number>> | null;
  totalCost?: number | string | null;
  tags?: readonly string[] | null;
  release?: string | null;
  traceName?: string | null;
}

export interface LangfuseTraceGraph {
  sourceHost: string;
  sourceTraceId: string;
  observations: readonly LangfuseObservation[];
}

type OtlpAnyValue = {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  nullValue?: string;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: Array<{ key: string; value: OtlpAnyValue }> };
};

type OtlpAttribute = { key: string; value: OtlpAnyValue };

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  status: { code: number; message?: string };
  attributes: OtlpAttribute[];
};

export type OtlpExportTraceServiceRequest = {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
  }>;
};

export interface ConvertedLangfuseTrace {
  traceId: string;
  spanCount: number;
  otlpRequests: readonly OtlpExportTraceServiceRequest[];
}

const MAX_SPANS_PER_REQUEST = 500;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const SPAN_KIND_INTERNAL = 0;

const SUPPORTED_OBSERVATION_TYPES = new Set([
  "AGENT",
  "GENERATION",
  "TOOL",
  "SPAN",
]);

export function mapApoTraceId(sourceHost: string, sourceTraceId: string): string {
  const digest = sha256Hex(
    `apo-trace-source\0langfuse\0${sourceHost}\0${sourceTraceId}`,
  );
  return finalizeHex(digest.slice(0, 32));
}

export function mapApoSpanId(sourceHost: string, observationId: string): string {
  const digest = sha256Hex(
    `apo-trace-source-span\0langfuse\0${sourceHost}\0${observationId}`,
  );
  return finalizeHex(digest.slice(0, 16));
}

export function convertLangfuseTraceToOtlp(
  graph: LangfuseTraceGraph,
): ConvertedLangfuseTrace {
  const validated = validateAndSortGraph(graph);
  const traceId = mapApoTraceId(graph.sourceHost, graph.sourceTraceId);

  const presentIds = new Set(validated.map((o) => o.id));
  const spans: OtlpSpan[] = validated.map((observation) =>
    buildSpan(observation, graph, traceId, presentIds),
  );

  const requests = chunkSpans(spans);
  return { traceId, spanCount: spans.length, otlpRequests: requests };
}

function buildSpan(
  observation: LangfuseObservation,
  graph: LangfuseTraceGraph,
  traceId: string,
  presentIds: Set<string>,
): OtlpSpan {
  const spanId = mapApoSpanId(graph.sourceHost, observation.id);
  const attributes: OtlpAttribute[] = [];
  const parentId = observation.parentObservationId ?? null;

  attributes.push(stringAttr("apo.trace.source.system", "langfuse"));
  attributes.push(stringAttr("apo.trace.source.observation_id", observation.id));
  attributes.push(
    stringAttr("apo.trace.source.observation_type", observation.type),
  );

  const isRoot = parentId === null || !presentIds.has(parentId);
  if (isRoot) {
    appendRootProvenance(attributes, observation, graph);
  } else {
    // parentSpanId will be set when serializing the chunk.
  }
  if (parentId !== null && !presentIds.has(parentId)) {
    attributes.push(
      stringAttr("apo.trace.source.missing_parent_id", parentId),
    );
  }

  appendSemanticAttributes(attributes, observation, isRoot);

  const span: OtlpSpan = {
    traceId,
    spanId,
    name: observation.name ?? `langfuse.${observation.type.toLowerCase()}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: isoToUnixNanos(observation.startTime),
    status: buildStatus(observation),
    attributes,
  };
  if (observation.endTime) {
    span.endTimeUnixNano = isoToUnixNanos(observation.endTime);
  }
  if (parentId && presentIds.has(parentId)) {
    span.parentSpanId = mapApoSpanId(graph.sourceHost, parentId);
  }
  return span;
}

function appendRootProvenance(
  attributes: OtlpAttribute[],
  observation: LangfuseObservation,
  graph: LangfuseTraceGraph,
): void {
  const provenance: { source: { system: string; host: string; traceId: string }; release?: string } = {
    source: {
      system: "langfuse",
      host: graph.sourceHost,
      traceId: graph.sourceTraceId,
    },
  };
  if (observation.release) provenance.release = observation.release;
  attributes.push(anyValueAttr("apo.trace.provenance", provenance));
  attributes.push(
    stringAttr("apo.trace.source.trace_id", graph.sourceTraceId),
  );
  if (observation.traceName) {
    attributes.push(stringAttr("apo.trace.name", observation.traceName));
  }
  const tags = mergeTraceTags(observation.tags);
  attributes.push(anyValueAttr("apo.trace.tags", tags));
  const traceMeta: { release?: string } = {};
  if (observation.release) traceMeta.release = observation.release;
  attributes.push(anyValueAttr("apo.trace.metadata", traceMeta));
}

function appendSemanticAttributes(
  attributes: OtlpAttribute[],
  observation: LangfuseObservation,
  _isRoot: boolean,
): void {
  const canonicalType = canonicalObservationType(observation.type);
  attributes.push(stringAttr("apo.observation.type", canonicalType));

  if (observation.level && observation.level !== "DEFAULT") {
    attributes.push(stringAttr("apo.observation.level", observation.level));
  }

  if (observation.input !== undefined) {
    attributes.push(anyValueAttr("apo.observation.input", { value: observation.input }));
    const inputMessages = extractMessageShapedJson(observation.input);
    if (inputMessages !== undefined) {
      attributes.push(anyValueAttr("gen_ai.input.messages", inputMessages));
    }
  }
  if (observation.output !== undefined) {
    attributes.push(anyValueAttr("apo.observation.output", { value: observation.output }));
    const outputMessages = extractMessageShapedJson(observation.output);
    if (outputMessages !== undefined) {
      attributes.push(anyValueAttr("gen_ai.output.messages", outputMessages));
    }
  }
  if (observation.metadata !== undefined) {
    attributes.push(anyValueAttr("apo.observation.metadata", observation.metadata));
  }

  if (observation.providedModelName) {
    attributes.push(
      stringAttr("gen_ai.request.model", observation.providedModelName),
    );
  }

  appendUsage(attributes, observation.usageDetails);
  appendCost(attributes, observation.totalCost);
}

function appendUsage(
  attributes: OtlpAttribute[],
  usageDetails: Readonly<Record<string, number>> | null | undefined,
): void {
  if (!usageDetails) return;
  const input = pickUsage(usageDetails, ["input", "prompt"]);
  const output = pickUsage(usageDetails, ["output", "completion"]);
  if (input !== undefined) {
    attributes.push(intAttr("gen_ai.usage.input_tokens", input));
  }
  if (output !== undefined) {
    attributes.push(intAttr("gen_ai.usage.output_tokens", output));
  }
}

function appendCost(
  attributes: OtlpAttribute[],
  totalCost: number | string | null | undefined,
): void {
  const amount = parseReportedCost(totalCost);
  if (amount === null) return;
  attributes.push(doubleAttr("apo.observation.cost.amount", amount));
  attributes.push(stringAttr("apo.observation.cost.currency", "USD"));
}

function buildStatus(observation: LangfuseObservation): {
  code: number;
  message?: string;
} {
  if (observation.level === "ERROR") {
    if (observation.statusMessage) {
      return { code: 2, message: observation.statusMessage };
    }
    return { code: 2 };
  }
  return { code: 0 };
}

function mergeTraceTags(tags: readonly string[] | null | undefined): string[] {
  const out = ["imported", "source:langfuse"];
  for (const t of tags ?? []) {
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function canonicalObservationType(type: string): string {
  const upper = type.toUpperCase();
  if (SUPPORTED_OBSERVATION_TYPES.has(upper)) return upper;
  return "SPAN";
}

function pickUsage(
  usage: Readonly<Record<string, number>>,
  keys: readonly string[],
): number | undefined {
  for (const k of keys) {
    if (typeof usage[k] === "number") return usage[k];
  }
  return undefined;
}

function parseReportedCost(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function extractMessageShapedJson(value: JsonValue): JsonValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return undefined;
  if (!messages.every(isMessageShaped)) return undefined;
  return messages as unknown as JsonValue;
}

function isMessageShaped(m: unknown): boolean {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return false;
  const r = m as { role?: unknown; content?: unknown };
  return typeof r.role === "string" && "content" in r;
}

function isoToUnixNanos(iso: string): string {
  return (Date.parse(iso) * 1_000_000).toString();
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function finalizeHex(hex: string): string {
  if (/^0+$/.test(hex)) {
    return hex.slice(0, -1) + "1";
  }
  return hex;
}

function validateAndSortGraph(
  graph: LangfuseTraceGraph,
): LangfuseObservation[] {
  if (graph.observations.length === 0) {
    throw new Error(
      "Langfuse trace graph is empty: no observations were returned for source trace",
    );
  }
  const seen = new Set<string>();
  for (const obs of graph.observations) {
    if (obs.traceId !== graph.sourceTraceId) {
      throw new Error(
        `Langfuse observation ${obs.id} traceId (${obs.traceId}) does not match requested source trace ${graph.sourceTraceId}`,
      );
    }
    if (seen.has(obs.id)) {
      throw new Error(`Duplicate Langfuse observation id: ${obs.id}`);
    }
    seen.add(obs.id);
    if (!Number.isFinite(Date.parse(obs.startTime))) {
      throw new Error(
        `Langfuse observation ${obs.id} has invalid startTime: ${obs.startTime}`,
      );
    }
  }
  assertNoCycles(graph.observations);

  return [...graph.observations].sort(compareObservationOrder);
}

function compareObservationOrder(
  a: LangfuseObservation,
  b: LangfuseObservation,
): number {
  const byTime = a.startTime.localeCompare(b.startTime);
  if (byTime !== 0) return byTime;
  return a.id.localeCompare(b.id);
}

function assertNoCycles(observations: readonly LangfuseObservation[]): void {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const visited = new Set<string>();
  const stack = new Set<string>();

  for (const start of observations) {
    let cursor: LangfuseObservation | undefined = start;
    const path: string[] = [];
    while (cursor && cursor.parentObservationId && byId.has(cursor.parentObservationId)) {
      if (stack.has(cursor.id)) {
        throw new Error(
          `Parent cycle detected in Langfuse graph: ${[...path, cursor.id].join(" -> ")}`,
        );
      }
      if (visited.has(cursor.id)) break;
      stack.add(cursor.id);
      path.push(cursor.id);
      cursor = byId.get(cursor.parentObservationId);
    }
    for (const id of stack) visited.add(id);
    stack.clear();
  }
}

function chunkSpans(spans: readonly OtlpSpan[]): OtlpExportTraceServiceRequest[] {
  if (spans.length === 0) return [];
  const requests: OtlpExportTraceServiceRequest[] = [];
  let current: OtlpSpan[] = [];
  for (const span of spans) {
    const candidate = [...current, span];
    const serialized = JSON.stringify(wrapRequest(candidate)).length;
    if (serialized > MAX_REQUEST_BYTES) {
      if (current.length === 0) {
        throw new Error(
          `Single span cannot be chunked below the ${MAX_REQUEST_BYTES}-byte OTLP request limit`,
        );
      }
      requests.push(wrapRequest(current));
      current = [span];
    } else if (candidate.length > MAX_SPANS_PER_REQUEST) {
      requests.push(wrapRequest(current));
      current = [span];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) requests.push(wrapRequest(current));
  return requests;
}

function wrapRequest(spans: OtlpSpan[]): OtlpExportTraceServiceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttr("service.name", "apo-trace-source"),
            stringAttr("apo.trace.source.system", "langfuse"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "apo.langfuse-import" },
            spans: spans,
          },
        ],
      },
    ],
  };
}

function stringAttr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function doubleAttr(key: string, value: number): OtlpAttribute {
  return { key, value: { doubleValue: value } };
}

function anyValueAttr(key: string, value: JsonValue): OtlpAttribute {
  return { key, value: toJsonAnyValue(value) };
}

function toJsonAnyValue(value: JsonValue): OtlpAnyValue {
  if (value === null) return { nullValue: "NULL_VALUE" };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toJsonAnyValue) } };
  }
  return {
    kvlistValue: {
      values: Object.entries(value).map(([k, v]) => ({
        key: k,
        value: toJsonAnyValue(v),
      })),
    },
  };
}
