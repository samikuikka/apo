import { describe, expect, it } from "vitest";
import {
  convertLangfuseTraceToOtlp,
  finalizeHex,
  mapApoTraceId,
  mapApoSpanId,
} from "../src/lib/trace-sources/langfuse-otlp.ts";
import type { LangfuseObservation, LangfuseTraceGraph } from "../src/lib/trace-sources/langfuse-otlp.ts";

const HOST = "https://cloud.langfuse.com";
const TRACE_ID = "8f38c27a2c4b4bafb87a78e3a3d62b90";

function obs(over: Partial<LangfuseObservation> & { id: string }): LangfuseObservation {
  return {
    id: over.id,
    traceId: over.traceId ?? TRACE_ID,
    parentObservationId: over.parentObservationId ?? null,
    type: over.type ?? "SPAN",
    startTime: over.startTime ?? "2026-07-22T10:00:00.000000Z",
    endTime: over.endTime ?? "2026-07-22T10:00:01.000000Z",
    name: over.name ?? null,
    level: over.level ?? "DEFAULT",
    statusMessage: over.statusMessage ?? null,
    input: over.input,
    output: over.output,
    metadata: over.metadata,
    providedModelName: over.providedModelName ?? null,
    usageDetails: over.usageDetails ?? null,
    costDetails: over.costDetails ?? null,
    totalCost: over.totalCost ?? null,
    tags: over.tags ?? null,
    release: over.release ?? null,
    traceName: over.traceName ?? null,
  };
}

function graph(observations: LangfuseObservation[], host = HOST, traceId = TRACE_ID): LangfuseTraceGraph {
  return { sourceHost: host, sourceTraceId: traceId, observations };
}

function spanAttrs(span: unknown): Map<string, unknown> {
  const attrs = (span as { attributes?: Array<{ key: string; value: unknown }> }).attributes ?? [];
  return new Map(attrs.map((a) => [a.key, a.value]));
}

function attrValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const obj = v as Record<string, unknown>;
  if ("nullValue" in obj) return null;
  if ("stringValue" in obj) return obj.stringValue;
  if ("intValue" in obj) return Number(obj.intValue);
  if ("doubleValue" in obj) return Number(obj.doubleValue);
  if ("boolValue" in obj) return obj.boolValue;
  if ("arrayValue" in obj) return (obj.arrayValue as { values?: unknown[] }).values?.map(attrValue);
  if ("kvlistValue" in obj) {
    const kvs = (obj.kvlistValue as { values?: Array<{ key: string; value: unknown }> }).values ?? [];
    const out: Record<string, unknown> = {};
    for (const kv of kvs) out[kv.key] = attrValue(kv.value);
    return out;
  }
  return v;
}

function allSpans(result: { otlpRequests: unknown[] }): unknown[] {
  const spans: unknown[] = [];
  for (const req of result.otlpRequests) {
    const rs = (req as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }> }).resourceSpans ?? [];
    for (const r of rs) for (const s of r.scopeSpans ?? []) for (const sp of s.spans ?? []) spans.push(sp);
  }
  return spans;
}

describe("langfuse-otlp identity mapping", () => {
  it("produces deterministic, valid OTel trace and span IDs", () => {
    const g = graph([obs({ id: "obs-1" }), obs({ id: "obs-2", parentObservationId: "obs-1" })]);

    const first = convertLangfuseTraceToOtlp(g);
    const second = convertLangfuseTraceToOtlp(g);

    const traceId = first.traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe("0".repeat(32));
    expect(second.traceId).toBe(traceId);

    const spans = allSpans(first);
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      const sid = (span as { spanId?: string }).spanId;
      expect(sid).toMatch(/^[0-9a-f]{16}$/);
      expect(sid).not.toBe("0".repeat(16));
      expect((span as { traceId?: string }).traceId).toBe(traceId);
    }
  });

  it("changes the mapped trace ID when the source host changes", () => {
    const obs1 = obs({ id: "obs-1" });
    const a = convertLangfuseTraceToOtlp(graph([obs1], "https://cloud.langfuse.com"));
    const b = convertLangfuseTraceToOtlp(graph([obs1], "https://us.langfuse.com"));
    expect(a.traceId).not.toBe(b.traceId);
  });

  it("exposes mapApoTraceId / mapApoSpanId as stable primitives", () => {
    const t = mapApoTraceId(HOST, TRACE_ID);
    const s = mapApoSpanId(HOST, "obs-1");
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(s).toMatch(/^[0-9a-f]{16}$/);
    expect(mapApoTraceId(HOST, TRACE_ID)).toBe(t);
    expect(mapApoSpanId(HOST, "obs-1")).toBe(s);
  });

  it("replaces an all-zero prefix deterministically (theoretical safeguard)", () => {
    expect(finalizeHex("0".repeat(32))).toBe("0".repeat(31) + "1");
    expect(finalizeHex("0".repeat(16))).toBe("0".repeat(15) + "1");
    expect(finalizeHex("00000abc")).toBe("00000abc");
    expect(finalizeHex("0".repeat(32))).toBe(finalizeHex("0".repeat(32)));
  });

  it("preserves the original source IDs in span attributes", () => {
    const result = convertLangfuseTraceToOtlp(graph([obs({ id: "obs-1" })]));
    const span = allSpans(result)[0] as { attributes?: Array<{ key: string; value: unknown }> };
    const attrs = spanAttrs(span);
    expect(attrValue(attrs.get("apo.trace.source.system"))).toBe("langfuse");
    expect(attrValue(attrs.get("apo.trace.source.observation_id"))).toBe("obs-1");
  });
});

describe("langfuse-otlp graph preservation", () => {
  it("maps known parent relationships and detaches missing parents as roots", () => {
    const observations = [
      obs({ id: "root", startTime: "2026-07-22T10:00:00.000000Z" }),
      obs({ id: "child", parentObservationId: "root", startTime: "2026-07-22T10:00:01.000000Z" }),
      obs({ id: "grandchild", parentObservationId: "child", startTime: "2026-07-22T10:00:02.000000Z" }),
      obs({ id: "orphan", parentObservationId: "ghost", startTime: "2026-07-22T10:00:03.000000Z" }),
    ];
    const result = convertLangfuseTraceToOtlp(graph(observations));
    const spans = allSpans(result) as Array<{
      spanId: string;
      parentSpanId?: string;
      attributes?: Array<{ key: string; value: unknown }>;
    }>;

    const byObs = new Map<string, { span: typeof spans[number]; sourceId: string }>();
    for (const span of spans) {
      const a = spanAttrs(span);
      byObs.set(String(attrValue(a.get("apo.trace.source.observation_id"))), { span, sourceId: "" });
    }

    const root = byObs.get("root")!.span;
    const child = byObs.get("child")!.span;
    const grand = byObs.get("grandchild")!.span;
    const orphan = byObs.get("orphan")!.span;

    expect(root.parentSpanId).toBeUndefined();
    expect(child.parentSpanId).toBe(root.spanId);
    expect(grand.parentSpanId).toBe(child.spanId);

    // Orphan detached to a root and source parent id recorded.
    expect(orphan.parentSpanId).toBeUndefined();
    const orphanAttrs = spanAttrs(orphan);
    expect(attrValue(orphanAttrs.get("apo.trace.source.missing_parent_id"))).toBe("ghost");
  });

  it("sorts spans deterministically by startTime then observation id", () => {
    const observations = [
      obs({ id: "b-obs", startTime: "2026-07-22T10:00:00.000000Z" }),
      obs({ id: "a-obs", startTime: "2026-07-22T10:00:00.000000Z" }),
      obs({ id: "c-obs", startTime: "2026-07-22T10:00:05.000000Z" }),
    ];
    const result = convertLangfuseTraceToOtlp(graph(observations));
    const spans = allSpans(result) as Array<{ attributes?: Array<{ key: string; value: unknown }> }>;
    const sourceIds = spans.map((s) => String(attrValue(spanAttrs(s).get("apo.trace.source.observation_id"))));
    expect(sourceIds).toEqual(["a-obs", "b-obs", "c-obs"]);
  });
});

describe("langfuse-otlp semantic mapping", () => {
  it("encodes generation semantics into canonical gen_ai.* and apo.* attributes", () => {
    const observations = [
      obs({
        id: "root",
        type: "TRACE",
        traceName: "My Trace",
        tags: ["prod"],
        release: "v1.2.3",
      }),
      obs({
        id: "gen",
        type: "GENERATION",
        parentObservationId: "root",
        name: "chat gpt-4o",
        providedModelName: "gpt-4o",
        usageDetails: { input: 120, output: 45, total: 165 },
        totalCost: "0.0123",
        input: { messages: [{ role: "user", content: "hi" }] },
        output: { messages: [{ role: "assistant", content: "hello" }] },
        metadata: { request_id: "req-1" },
      }),
      obs({
        id: "err",
        type: "GENERATION",
        parentObservationId: "root",
        level: "ERROR",
        statusMessage: "boom: unauthorized",
      }),
    ];

    const result = convertLangfuseTraceToOtlp(graph(observations));
    const spans = allSpans(result) as Array<{
      name: string;
      attributes?: Array<{ key: string; value: unknown }>;
      status?: { code?: number; message?: string };
    }>;
    const byObs = new Map<string, typeof spans[number]>();
    for (const s of spans) {
      const a = spanAttrs(s);
      byObs.set(String(attrValue(a.get("apo.trace.source.observation_id"))), s);
    }

    const root = byObs.get("root")!;
    const rootAttrs = spanAttrs(root);
    expect(attrValue(rootAttrs.get("apo.trace.name"))).toBe("My Trace");
    expect(attrValue(rootAttrs.get("apo.trace.tags"))).toEqual(["imported", "source:langfuse", "prod"]);
    expect(attrValue(rootAttrs.get("apo.trace.metadata"))).toMatchObject({ release: "v1.2.3" });
    expect(attrValue(rootAttrs.get("apo.trace.source.trace_id"))).toBe(TRACE_ID);
    const provenance = attrValue(rootAttrs.get("apo.trace.provenance"));
    expect(provenance).toMatchObject({
      source: { system: "langfuse", host: HOST, traceId: TRACE_ID },
      release: "v1.2.3",
    });

    const gen = byObs.get("gen")!;
    const genAttrs = spanAttrs(gen);
    expect(gen.name).toBe("chat gpt-4o");
    expect(attrValue(genAttrs.get("apo.observation.type"))).toBe("GENERATION");
    expect(attrValue(genAttrs.get("gen_ai.request.model"))).toBe("gpt-4o");
    expect(attrValue(genAttrs.get("gen_ai.usage.input_tokens"))).toBe(120);
    expect(attrValue(genAttrs.get("gen_ai.usage.output_tokens"))).toBe(45);
    expect(attrValue(genAttrs.get("apo.observation.cost.amount"))).toBeCloseTo(0.0123, 6);
    expect(attrValue(genAttrs.get("apo.observation.cost.currency"))).toBe("USD");
    const inputKv = attrValue(genAttrs.get("apo.observation.input"));
    expect(inputKv).toMatchObject({ value: { messages: [{ role: "user", content: "hi" }] } });
    expect(attrValue(genAttrs.get("gen_ai.input.messages"))).toMatchObject([
      { role: "user", content: "hi" },
    ]);
    expect(attrValue(genAttrs.get("gen_ai.output.messages"))).toMatchObject([
      { role: "assistant", content: "hello" },
    ]);
    expect(attrValue(genAttrs.get("apo.observation.metadata"))).toMatchObject({ request_id: "req-1" });
    expect(gen.status?.code).not.toBe(2); // not ERROR

    const err = byObs.get("err")!;
    expect(err.status?.code).toBe(2);
    expect(err.status?.message).toBe("boom: unauthorized");
    const errAttrs = spanAttrs(err);
    expect(attrValue(errAttrs.get("apo.observation.level"))).toBe("ERROR");
  });

  it("maps EVENT and unknown types to generic SPAN, retaining the original type", () => {
    const observations = [
      obs({ id: "evt", type: "EVENT" }),
      obs({ id: "weird", type: "TOTALLY_UNKNOWN" }),
    ];
    const result = convertLangfuseTraceToOtlp(graph(observations));
    const spans = allSpans(result) as Array<{ name: string; attributes?: Array<{ key: string; value: unknown }> }>;
    const byObs = new Map<string, typeof spans[number]>();
    for (const s of spans) {
      const a = spanAttrs(s);
      byObs.set(String(attrValue(a.get("apo.trace.source.observation_id"))), s);
    }

    const evt = byObs.get("evt")!;
    expect(evt.name).toBe("langfuse.event");
    expect(attrValue(spanAttrs(evt).get("apo.observation.type"))).toBe("SPAN");
    expect(attrValue(spanAttrs(evt).get("apo.trace.source.observation_type"))).toBe("EVENT");

    const weird = byObs.get("weird")!;
    expect(weird.name).toBe("langfuse.totally_unknown");
    expect(attrValue(spanAttrs(weird).get("apo.observation.type"))).toBe("SPAN");
    expect(attrValue(spanAttrs(weird).get("apo.trace.source.observation_type"))).toBe("TOTALLY_UNKNOWN");
  });

  it("preserves a finite, non-negative reported cost and ignores invalid values", () => {
    const observations = [
      obs({ id: "ok", totalCost: "0.5" }),
      obs({ id: "neg", totalCost: -1 }),
      obs({ id: "nan", totalCost: "not-a-number" }),
    ];
    const result = convertLangfuseTraceToOtlp(graph(observations));
    const spans = allSpans(result) as Array<{ attributes?: Array<{ key: string; value: unknown }> }>;
    const byObs = new Map<string, typeof spans[number]>();
    for (const s of spans) {
      const a = spanAttrs(s);
      byObs.set(String(attrValue(a.get("apo.trace.source.observation_id"))), s);
    }
    expect(attrValue(spanAttrs(byObs.get("ok")!).get("apo.observation.cost.amount"))).toBeCloseTo(0.5, 6);
    expect(spanAttrs(byObs.get("neg")!).get("apo.observation.cost.amount")).toBeUndefined();
    expect(spanAttrs(byObs.get("nan")!).get("apo.observation.cost.amount")).toBeUndefined();
  });
});

describe("langfuse-otlp JSON AnyValue encoding", () => {
  it("round-trips nested objects, arrays, primitives, unicode, and explicit null", () => {
    const payload = {
      obj: { a: 1, b: { c: "deep" }, d: null },
      arr: [1, "two", true, null, { nested: "yes" }],
      str: "Unicode: 😀 你好",
      num: 3.14,
      bool: false,
      nil: null,
    };
    const observations = [obs({ id: "root", input: payload, output: payload, metadata: payload })];
    const result = convertLangfuseTraceToOtlp(graph(observations));
    const span = allSpans(result)[0] as { attributes?: Array<{ key: string; value: unknown }> };
    const attrs = spanAttrs(span);
    // Non-object JSON values are wrapped as { value: ... }.
    expect(attrValue(attrs.get("apo.observation.input"))).toEqual({ value: payload });
    expect(attrValue(attrs.get("apo.observation.output"))).toEqual({ value: payload });
    expect(attrValue(attrs.get("apo.observation.metadata"))).toEqual(payload);
  });

  it("encodes JSON null as an explicit AnyValue, not an empty value", () => {
    const observations = [obs({ id: "root", input: null })];
    const result = convertLangfuseTraceToOtlp(graph(observations));
    const span = allSpans(result)[0] as { attributes?: Array<{ key: string; value: unknown }> };
    const attrs = spanAttrs(span);
    // The wire value must carry an explicit null marker (not an empty object).
    const raw = attrs.get("apo.observation.input") as Record<string, unknown> | undefined;
    expect(raw).toBeDefined();
    expect(raw).toHaveProperty("kvlistValue");
    // Decoding the kvlistValue yields { value: null } (wrapped null), and the
    // null is represented explicitly — not as `{}`.
    const decoded = attrValue(raw);
    expect(decoded).toEqual({ value: null });
    const inner = (raw as { kvlistValue: { values: Array<{ key: string; value: unknown }> } })
      .kvlistValue.values[0]!.value;
    expect(inner).toHaveProperty("nullValue", "NULL_VALUE");
  });
});

describe("langfuse-otlp malformed source graphs", () => {
  it("rejects an empty observation list", () => {
    expect(() => convertLangfuseTraceToOtlp(graph([]))).toThrow(/empty/i);
  });

  it("rejects rows whose traceId differs from the requested trace", () => {
    const observations = [
      obs({ id: "a", traceId: TRACE_ID }),
      obs({ id: "b", traceId: "some-other-trace" }),
    ];
    expect(() => convertLangfuseTraceToOtlp(graph(observations))).toThrow(/traceId/i);
  });

  it("rejects duplicate observation IDs", () => {
    const observations = [obs({ id: "dup" }), obs({ id: "dup" })];
    expect(() => convertLangfuseTraceToOtlp(graph(observations))).toThrow(/duplicate/i);
  });

  it("rejects an invalid startTime", () => {
    const observations = [obs({ id: "bad", startTime: "not-a-date" })];
    expect(() => convertLangfuseTraceToOtlp(graph(observations))).toThrow(/start/i);
  });

  it("rejects a parent cycle before producing any OTLP request", () => {
    const observations = [
      obs({ id: "a", parentObservationId: "b", startTime: "2026-07-22T10:00:00.000000Z" }),
      obs({ id: "b", parentObservationId: "a", startTime: "2026-07-22T10:00:01.000000Z" }),
    ];
    expect(() => convertLangfuseTraceToOtlp(graph(observations))).toThrow(/cycle/i);
  });
});

describe("langfuse-otlp chunking", () => {
  it("chunks under the span-count and byte boundaries", () => {
    const observations: LangfuseObservation[] = [];
    for (let i = 0; i < 1200; i++) {
      observations.push(obs({ id: `obs-${i}`, startTime: `2026-07-22T10:00:${(i % 60).toString().padStart(2, "0")}.000000Z` }));
    }
    const result = convertLangfuseTraceToOtlp(graph(observations));
    expect(result.otlpRequests.length).toBeGreaterThan(1);
    for (const req of result.otlpRequests) {
      const spans = allSpans({ otlpRequests: [req] });
      expect(spans.length).toBeLessThanOrEqual(500);
      const serialized = JSON.stringify(req).length;
      expect(serialized).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    expect(result.spanCount).toBe(observations.length);
  });

  it("fails if a single span is unchunkably large", () => {
    const huge = "x".repeat(9 * 1024 * 1024);
    const observations = [obs({ id: "huge", output: huge })];
    expect(() => convertLangfuseTraceToOtlp(graph(observations))).toThrow(/chunk/i);
  });
});
