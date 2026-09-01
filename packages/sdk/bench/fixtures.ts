/**
 * Deterministic fixtures for the SDK benchmark suite.
 *
 * The determinism contract mirrors the backend suite
 * (`backend/tests/benchmarks/conftest.py`): counter-derived ids and fixed
 * literal timestamps — no `Math.random`, no `Date.now` — so a CodSpeed
 * regression report measures the code, not fixture drift.
 *
 * Every builder is pure and cheap enough to be called once per benchmark file
 * at module scope, i.e. outside the measured region.
 */

import type {
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "../src/agent-task/trace-projection/types.ts";
import type { OtelSpanData } from "../src/agent-task/integrations/otel-translate.ts";
import type { ManifestFileInput } from "../src/agent-task/task-revision-manifest.ts";
import type {
  AnthropicMessage,
  OpenAIMessage,
} from "../src/agent-task/flow/sources.ts";

/** Fixed wall-clock anchor: 2026-09-01T00:00:00Z as a literal, never now(). */
const BASE_EPOCH_MS = Date.parse("2026-09-01T00:00:00.000Z");

/** Deterministic 16-hex span id (counter-derived, never all-zero). */
export function benchSpanId(counter: number): string {
  return (counter + 1).toString(16).padStart(16, "0");
}

/** Deterministic ISO timestamp, one span every 25ms from the fixed anchor. */
function benchIso(counter: number): string {
  return new Date(BASE_EPOCH_MS + counter * 25).toISOString();
}

// ── OTel spans ───────────────────────────────────────────────────────────

/** Span-name/attribute shapes covering both conventions the SDK translates. */
const SPAN_SHAPES = [
  (i: number): { name: string; data: OtelSpanData } => ({
    name: "ai.toolCall",
    data: {
      attributes: {
        "ai.toolCall.name": `search_invoices_${i % 5}`,
        "ai.toolCall.args": JSON.stringify({ customerId: i, limit: 25 }),
        "ai.toolCall.result": JSON.stringify({
          rows: [{ id: i, total: 12.5 }, { id: i + 1, total: 99 }],
        }),
      },
      status: { code: i % 17 === 0 ? 2 : 1, message: "tool failed" },
    },
  }),
  (i: number): { name: string; data: OtelSpanData } => ({
    name: "ai.generateText",
    data: {
      attributes: {
        "ai.model.id": "gpt-4o-mini",
        "ai.response.text": `assistant reply number ${i}`,
        "ai.usage.promptTokens": 512 + i,
        "ai.usage.completionTokens": 128,
        "ai.prompt.messages": JSON.stringify([
          { role: "user", content: `question ${i}` },
        ]),
      },
      status: { code: 1 },
    },
  }),
  (i: number): { name: string; data: OtelSpanData } => ({
    name: "chat gpt-4o-mini",
    data: {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.response.text": `standard genai reply ${i}`,
        "gen_ai.usage.input_tokens": 256,
        "gen_ai.usage.output_tokens": "64",
      },
      status: { code: 1 },
    },
  }),
  (i: number): { name: string; data: OtelSpanData } => ({
    name: "gen_ai.tool.execute",
    data: {
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": `fetch_docs_${i % 3}`,
        "gen_ai.tool.call.arguments": JSON.stringify({ query: `docs ${i}` }),
        "gen_ai.tool.call.result": JSON.stringify({ hits: i % 7 }),
      },
      status: { code: 1 },
    },
  }),
  (i: number): { name: string; data: OtelSpanData } => ({
    name: "invoke_agent researcher",
    data: {
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": `researcher_${i % 2}`,
        "gen_ai.tool.call.result": JSON.stringify({ summary: `done ${i}` }),
      },
      status: { code: 1 },
    },
  }),
  // Housekeeping span: translateOtelSpan must reject it. Real traces are full
  // of these, so the reject path belongs in the measurement.
  (i: number): { name: string; data: OtelSpanData } => ({
    name: "http.client.request",
    data: {
      attributes: { "http.method": "POST", "http.status_code": 200, seq: i },
      status: { code: 1 },
    },
  }),
] as const;

/** A mixed batch of OTel spans, as a span processor sees them. */
export function buildOtelSpans(
  count: number,
): ReadonlyArray<{ name: string; data: OtelSpanData }> {
  return Array.from({ length: count }, (_, i) =>
    SPAN_SHAPES[i % SPAN_SHAPES.length]!(i),
  );
}

// ── Trace projection snapshots ───────────────────────────────────────────

const OBSERVATION_TYPES = [
  "GENERATION",
  "TOOL",
  "AGENT",
  "SKILL",
  "CHAIN",
] as const;

function buildObservation(i: number): TraceProjectionObservation {
  const type = OBSERVATION_TYPES[i % OBSERVATION_TYPES.length]!;
  const base: TraceProjectionObservation = {
    spanId: benchSpanId(i),
    type,
    name: `${type.toLowerCase()}.step.${i}`,
    // Reverse the timestamps against array order so the TraceView sort is
    // real work rather than a no-op over already-ordered input.
    startedAt: benchIso(1024 - i),
    endedAt: benchIso(1024 - i + 1),
    durationMs: 25,
    status: i % 13 === 0 ? "error" : "ok",
  };
  if (type === "GENERATION") {
    return {
      ...base,
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: `question ${i}` },
        { role: "assistant", content: `assistant reply number ${i}` },
      ],
    };
  }
  if (type === "TOOL") {
    return {
      ...base,
      toolName: `search_invoices_${i % 5}`,
      toolParameters: { customerId: i, limit: 25 },
      toolResult: { rows: [{ id: i, total: 12.5 }] },
      ...(i % 13 === 0 ? { errorMessage: "upstream timeout" } : {}),
    };
  }
  if (type === "AGENT") {
    return { ...base, output: { summary: `delegated ${i}` } };
  }
  return base;
}

/**
 * A snapshot shaped like a real agent run: 250 observations across every
 * projected type, with unsorted timestamps and full capability coverage.
 */
export function buildSnapshot(observationCount: number): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: {
      traceId: "0".repeat(31) + "1",
      taskRunId: "run-bench-1",
      name: "bench.flow",
      startedAt: benchIso(0),
      endedAt: benchIso(observationCount + 1),
      durationMs: 25 * (observationCount + 1),
      complete: true,
    },
    capabilities: {
      messages: "available",
      tools: "available",
      errors: "available",
      timing: "available",
      skills: "available",
      subagents: "available",
    },
    observations: Array.from({ length: observationCount }, (_, i) =>
      buildObservation(i),
    ),
  };
}

// ── Provider message logs (Flow normalizers) ─────────────────────────────

/** An OpenAI chat-completions message log with interleaved tool results. */
export function buildOpenAIMessages(turns: number): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [
    { role: "system", content: "You are a billing agent." },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `question ${i}` });
    messages.push({
      role: "assistant",
      content: `assistant reply number ${i}`,
      tool_calls: [
        {
          id: `call_${i}`,
          function: {
            name: `search_invoices_${i % 5}`,
            arguments: JSON.stringify({ customerId: i, limit: 25 }),
          },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `call_${i}`,
      content: JSON.stringify({ rows: [{ id: i, total: 12.5 }] }),
    });
  }
  return messages;
}

/** The Anthropic content-block equivalent of {@link buildOpenAIMessages}. */
export function buildAnthropicMessages(turns: number): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `question ${i}` }],
    });
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `assistant reply number ${i}` },
        {
          type: "tool_use",
          id: `toolu_${i}`,
          name: `search_invoices_${i % 5}`,
          input: { customerId: i, limit: 25 },
        },
      ],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_${i}`,
          content: { rows: [{ id: i, total: 12.5 }] },
        },
      ],
    });
  }
  return messages;
}

// ── Task revision manifest ───────────────────────────────────────────────

const encoder = new TextEncoder();

/**
 * A task directory as the packer sees it: source files of a few KB each, in
 * deliberately unsorted order and with non-ASCII paths so the bytewise UTF-8
 * ordering rule is actually exercised.
 */
export function buildManifestFiles(fileCount: number): ManifestFileInput[] {
  const files: ManifestFileInput[] = [];
  for (let i = 0; i < fileCount; i++) {
    const dir = ["src", "tests", "sköldpadda", "docs"][i % 4]!;
    // Descending index => input order is the reverse of the canonical order.
    const idx = fileCount - i;
    files.push({
      path: `${dir}/module-${String(idx).padStart(4, "0")}.ts`,
      modeClass: i % 20 === 0 ? "executable" : "regular",
      content: encoder.encode(
        `// module ${idx}\n`.repeat(64) + `export const value = ${idx};\n`,
      ),
    });
  }
  return files;
}
