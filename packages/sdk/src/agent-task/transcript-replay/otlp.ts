/**
 * Transcript → OTLP/JSON translator.
 *
 * Converts a parsed session into exactly the span vocabulary apo's receiver
 * already normalizes best. Two rules make replayed traces indistinguishable
 * from live-OTel ones in the projection:
 *
 * 1. Every span carries an explicit ``apo.observation.type`` override — the
 *    priority-1 mapper — so typing (AGENT / GENERATION / TOOL / SPAN) never
 *    depends on the backend's registry guessing from attributes.
 * 2. Attributes use apo's established GenAI keys (``gen_ai.request.model``,
 *    ``gen_ai.usage.*`` incl. the cache/reasoning buckets the pricing path
 *    reads, ``gen_ai.tool.*``, ``gen_ai.input/output.messages``) — not a
 *    replay-specific dialect.
 *
 * IDs are SHA-256-derived from the session identity, so re-exporting the same
 * transcript is idempotent: the receiver upserts on
 * ``(project_id, trace_id, span_id)``.
 */

import { createHash } from "node:crypto";

import type { ParsedTranscriptSession, TranscriptToolCall, TranscriptTurn } from "./types.ts";

// ── OTLP structural types (the subset the apo receiver consumes) ──────────

export type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean };

export type OtlpAttribute = { key: string; value: OtlpAttributeValue };

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number };
};

export type OtlpTracesPayload = {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
};

export type TranscriptReplayOptions = {
  /** Trace id (32 lowercase hex). Default: deterministic from source + session id. */
  traceId?: string;
  /** Parent for the first turn's interaction span — adapter capture mode nests it under the live task.turn span. */
  parentSpanId?: string;
  /** Run list label (`apo.run.flow_name`). Default: "<source> session <id prefix>". */
  flowName?: string;
  /** Run tags (`apo.run.tags`). Default: ["transcript-replay", source]. */
  tags?: string[];
};

const SPAN_KIND_INTERNAL = 1;
const STATUS_CODE_UNSET = 0;

// ── Translation ────────────────────────────────────────────────────────────

export function transcriptSessionToOtlp(
  session: ParsedTranscriptSession,
  options: TranscriptReplayOptions = {},
): OtlpTracesPayload {
  const prefix = session.source === "claude-code" ? "claude_code" : "codex";
  const system = session.source === "claude-code" ? "anthropic" : "openai";
  const traceId = options.traceId ?? deriveTraceId(session.source, session.sessionId);
  const flowName =
    options.flowName ?? `${session.source} session ${session.sessionId.slice(0, 8)}`;
  const tags = options.tags ?? ["transcript-replay", session.source];

  const spans: OtlpSpan[] = [];
  for (const turn of session.turns) {
    spans.push(...turnSpans(turn, { traceId, prefix, system, flowName, tags, options }));
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttr("service.name", "apo-transcript-replay"),
            stringAttr("apo.transcript.source", session.source),
            stringAttr("apo.transcript.session_id", session.sessionId),
            ...(session.cwd !== undefined
              ? [stringAttr("apo.transcript.cwd", session.cwd)]
              : []),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "apo-transcript-replay", version: "1" },
            spans,
          },
        ],
      },
    ],
  };
}

type TurnContext = {
  traceId: string;
  prefix: string;
  system: string;
  flowName: string;
  tags: string[];
  options: TranscriptReplayOptions;
};

function turnSpans(turn: TranscriptTurn, ctx: TurnContext): OtlpSpan[] {
  const { traceId, prefix, system } = ctx;
  const interactionId = deriveSpanId(`${traceId}|${turn.index}|interaction`);
  // Adapter capture joins EVERY interaction span under the live run root: the
  // transcript is one session, and its turns have no reliable 1:1 mapping to
  // the runner's task.turn spans.
  const parent = ctx.options.parentSpanId;
  const startNanos = isoToNanos(turn.startedAt);
  const endNanos = maxNanos(startNanos, isoToNanos(turn.endedAt));
  const timing = { startTimeUnixNano: startNanos, endTimeUnixNano: endNanos };

  const inputMessages = messageAttrValue("user", turn.userMessage);
  const outputMessages = messageAttrValue("assistant", turn.assistantMessage);

  // Turn root: the agent interaction. Run metadata rides the first turn of a
  // standalone trace only — when joining a live trace (parentSpanId set) the
  // run root already carries it, and a second flow_name on a nested span is
  // noise.
  const interaction: OtlpSpan = {
    traceId,
    spanId: interactionId,
    name: `${prefix}.interaction`,
    kind: SPAN_KIND_INTERNAL,
    ...timing,
    attributes: compactAttributes({
      "apo.observation.type": "AGENT",
      "gen_ai.system": system,
      "gen_ai.request.model": turn.model,
      "gen_ai.input.messages": inputMessages,
      "gen_ai.output.messages": outputMessages,
      ...(ctx.options.parentSpanId === undefined && turn.index === 0
        ? {
            "apo.run.flow_name": ctx.flowName,
            "apo.run.tags": JSON.stringify(ctx.tags),
          }
        : {}),
    }),
    status: { code: STATUS_CODE_UNSET },
    ...(parent !== undefined ? { parentSpanId: parent } : {}),
  };

  const generation: OtlpSpan = {
    traceId,
    spanId: deriveSpanId(`${traceId}|${turn.index}|llm_request`),
    parentSpanId: interactionId,
    name: `${prefix}.llm_request`,
    kind: SPAN_KIND_INTERNAL,
    ...timing,
    attributes: compactAttributes({
      "apo.observation.type": "GENERATION",
      "gen_ai.system": system,
      "gen_ai.request.model": turn.model,
      "gen_ai.input.messages": inputMessages,
      "gen_ai.output.messages": outputMessages,
      "gen_ai.usage.input_tokens": turn.usage?.inputTokens,
      "gen_ai.usage.output_tokens": turn.usage?.outputTokens,
      "gen_ai.usage.cache_read.input_tokens": turn.usage?.cacheReadTokens,
      "gen_ai.usage.cache_creation.input_tokens": turn.usage?.cacheWriteTokens,
      "gen_ai.usage.reasoning.output_tokens": turn.usage?.reasoningTokens,
    }),
    status: { code: STATUS_CODE_UNSET },
  };

  const spans: OtlpSpan[] = [interaction, generation];

  const thinkingText =
    turn.thinkingText ??
    (turn.usage?.reasoningTokens !== undefined
      ? `[reasoning ${turn.usage.reasoningTokens} tokens]`
      : undefined);
  if (thinkingText !== undefined) {
    spans.push({
      traceId,
      spanId: deriveSpanId(`${traceId}|${turn.index}|thinking`),
      parentSpanId: interactionId,
      name: `${prefix}.thinking`,
      kind: SPAN_KIND_INTERNAL,
      ...timing,
      attributes: compactAttributes({
        "apo.observation.type": "SPAN",
        "gen_ai.output.messages": messageAttrValue("assistant", thinkingText),
      }),
      status: { code: STATUS_CODE_UNSET },
    });
  }

  turn.toolCalls.forEach((call, callIndex) => {
    spans.push(toolSpan(call, { traceId, prefix, turnIndex: turn.index, callIndex, timing }));
  });

  return spans;
}

function toolSpan(
  call: TranscriptToolCall,
  ctx: {
    traceId: string;
    prefix: string;
    turnIndex: number;
    callIndex: number;
    timing: { startTimeUnixNano: string; endTimeUnixNano: string };
  },
): OtlpSpan {
  const { traceId, prefix, timing } = ctx;
  const parent = deriveSpanId(`${traceId}|${ctx.turnIndex}|interaction`);
  const callStart = isoToNanos(call.startedAt);
  const startNanos = callStart !== "0" ? callStart : timing.startTimeUnixNano;
  const endNanos = maxNanos(startNanos, isoToNanos(call.endedAt));
  return {
    traceId,
    spanId: deriveSpanId(`${traceId}|${ctx.turnIndex}|tool|${ctx.callIndex}|${call.callId}`),
    parentSpanId: parent,
    name: `${prefix}.tool`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: startNanos,
    endTimeUnixNano: endNanos,
    attributes: compactAttributes({
      "apo.observation.type": "TOOL",
      "gen_ai.tool.name": call.name,
      "gen_ai.tool.call.arguments":
        call.input === undefined ? undefined : JSON.stringify(call.input),
      "gen_ai.tool.call.result":
        call.result === undefined ? undefined : JSON.stringify(call.result),
    }),
    status: { code: STATUS_CODE_UNSET },
  };
}

// ── Attribute helpers ──────────────────────────────────────────────────────

type AttributeValueInput = string | number | undefined;

function compactAttributes(values: Record<string, AttributeValueInput>): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    attributes.push(
      typeof value === "number"
        ? { key, value: { intValue: String(value) } }
        : { key, value: { stringValue: value } },
    );
  }
  return attributes;
}

function stringAttr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function messageAttrValue(role: string, content: string | undefined): string | undefined {
  if (content === undefined || content === "") return undefined;
  return JSON.stringify([{ role, content }]);
}

// ── Ids and timestamps ─────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function deriveTraceId(source: string, sessionId: string): string {
  return sha256Hex(`apo-transcript-replay|${source}|${sessionId}`).slice(0, 32);
}

function deriveSpanId(seed: string): string {
  return sha256Hex(seed).slice(0, 16);
}

function isoToNanos(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "0";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "0";
  // BigInt() call rather than a literal: example-service typechecks SDK
  // sources with a pre-ES2020 target, where BigInt literals are a TS2737
  // error even though the runtime (Node >= 20) has BigInt.
  return String(BigInt(ms) * BigInt(1_000_000));
}

function maxNanos(a: string, b: string): string {
  return BigInt(b) > BigInt(a) ? b : a;
}
