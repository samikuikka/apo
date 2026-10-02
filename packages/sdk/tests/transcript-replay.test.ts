import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectTranscriptSource,
  exportOtlpTraces,
  parseClaudeCodeTranscript,
  parseCodexTranscript,
  resolveOtlpTracesUrl,
  TranscriptReplayError,
  transcriptSessionToOtlp,
  type OtlpSpan,
  type OtlpTracesPayload,
} from "../src/agent-task/public.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────
// Real-format excerpts: Claude Code project transcript lines (streamed chunks
// share message.id; tool results come back on user lines) and a Codex rollout
// (task bracket events + response items). The torn final line exercises the
// per-line fault tolerance a live-appended file needs.

const claudeFixture = [
  JSON.stringify({
    type: "user",
    sessionId: "sess-abc",
    cwd: "/tmp/demo",
    timestamp: "2026-10-01T10:00:00Z",
    message: { role: "user", content: "Read the invoice and extract totals." },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T10:00:05Z",
    requestId: "req_1",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
      content: [
        { type: "thinking", thinking: "I should read the file first." },
        { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "invoice.txt" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-10-01T10:00:06Z",
    toolUseResult: { durationMs: 12 },
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: [{ type: "text", text: "Invoice total: 100 EUR" }],
        },
      ],
    },
  }),
  // Second streamed chunk of the same message id — its usage snapshot is the
  // complete one; the parser must not take the first chunk's or sum them.
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T10:00:10Z",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 150,
        output_tokens: 25,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 30,
      },
      content: [{ type: "text", text: "The invoice total is 100 EUR." }],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-10-01T10:01:00Z",
    message: { role: "user", content: "Summarize in one word." },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T10:01:02Z",
    message: {
      id: "msg_2",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 200, output_tokens: 5 },
      content: [{ type: "text", text: "Paid." }],
    },
  }),
  '{"type":"summary","summary":"old conversation"}',
  '{"type":"assistant","times',
].join("\n");

const codexFixture = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-10-01T11:00:00Z",
    payload: { id: "codex-sess-1", cwd: "/tmp/codex" },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-10-01T11:00:01Z",
    payload: { model: "gpt-5.4", cwd: "/tmp/codex" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T11:00:01Z",
    payload: { type: "task_started", turn_id: "t1" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T11:00:02Z",
    payload: { type: "user_message", message: "List files." },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-01T11:00:03Z",
    payload: {
      type: "function_call",
      name: "shell",
      arguments: '{"cmd":["ls"]}',
      call_id: "call_1",
    },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-01T11:00:04Z",
    payload: { type: "function_call_output", call_id: "call_1", output: '{"output":"a.txt b.txt"}' },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-01T11:00:04Z",
    payload: {
      type: "reasoning",
      // Real rollouts serialize the Responses API's summary-part array.
      summary: [
        { type: "summary_text", text: "Checking directory." },
        { type: "summary_text", text: "Sorting output." },
      ],
    },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T11:00:05Z",
    payload: { type: "agent_message", phase: "commentary", message: "Listing files." },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T11:00:06Z",
    payload: { type: "agent_message", phase: "final_answer", message: "Two files." },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T11:00:05.500Z",
    payload: {
      type: "token_count",
      info: {
        // One event per API request; the turn's usage is their sum.
        last_token_usage: {
          input_tokens: 50,
          cached_input_tokens: 10,
          output_tokens: 7,
          reasoning_output_tokens: 3,
        },
      },
    },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T11:00:06Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 30, output_tokens: 5 } },
    },
  }),
  // No task_complete: the session ended mid-bracket and must still commit.
].join("\n");

// ── Claude Code parser ─────────────────────────────────────────────────────

describe("parseClaudeCodeTranscript", () => {
  it("groups streamed chunks into turns with tools, thinking, and usage", () => {
    const session = parseClaudeCodeTranscript(claudeFixture);

    expect(session.source).toBe("claude-code");
    expect(session.sessionId).toBe("sess-abc");
    expect(session.cwd).toBe("/tmp/demo");
    expect(session.turns).toHaveLength(2);

    const [first, second] = session.turns;
    expect(first.startedAt).toBe("2026-10-01T10:00:00Z");
    expect(first.endedAt).toBe("2026-10-01T10:00:10Z");
    expect(first.model).toBe("claude-sonnet-5");
    expect(first.userMessage).toBe("Read the invoice and extract totals.");
    expect(first.assistantMessage).toBe("The invoice total is 100 EUR.");
    expect(first.thinkingText).toBe("I should read the file first.");

    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]).toMatchObject({
      callId: "tu_1",
      name: "Read",
      input: { file_path: "invoice.txt" },
      result: "Invoice total: 100 EUR",
      startedAt: "2026-10-01T10:00:05Z",
      endedAt: "2026-10-01T10:00:06Z",
    });

    // Most-complete snapshot of msg_1, not the first chunk's, not summed.
    expect(first.usage).toEqual({
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 60,
      cacheWriteTokens: 30,
    });

    expect(second.userMessage).toBe("Summarize in one word.");
    expect(second.assistantMessage).toBe("Paid.");
    expect(second.usage).toEqual({ inputTokens: 200, outputTokens: 5 });
    expect(second.toolCalls).toHaveLength(0);
  });

  it("skips torn lines with a warning instead of failing", () => {
    const session = parseClaudeCodeTranscript(claudeFixture);
    expect(session.warnings).toHaveLength(1);
    expect(session.warnings[0]).toContain("1 unparseable line");
  });

  it("parses an empty file into an empty session", () => {
    const session = parseClaudeCodeTranscript("");
    expect(session.turns).toEqual([]);
    expect(session.warnings).toEqual([]);
    expect(session.sessionId).toBe("");
  });
});

// ── Codex parser ───────────────────────────────────────────────────────────

describe("parseCodexTranscript", () => {
  it("reconstructs turns from task brackets and response items", () => {
    const session = parseCodexTranscript(codexFixture);

    expect(session.source).toBe("codex");
    expect(session.sessionId).toBe("codex-sess-1");
    expect(session.cwd).toBe("/tmp/codex");
    expect(session.turns).toHaveLength(1);

    const [turn] = session.turns;
    expect(turn.model).toBe("gpt-5.4");
    expect(turn.userMessage).toBe("List files.");
    expect(turn.assistantMessage).toBe("Two files.");
    expect(turn.commentary).toEqual(["Listing files."]);
    expect(turn.thinkingText).toBe("Checking directory.\nSorting output.");
    expect(turn.startedAt).toBe("2026-10-01T11:00:01Z");
    expect(turn.endedAt).toBe("2026-10-01T11:00:06Z");

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({
      callId: "call_1",
      name: "shell",
      input: { cmd: ["ls"] },
      result: '{"output":"a.txt b.txt"}',
      startedAt: "2026-10-01T11:00:03Z",
      endedAt: "2026-10-01T11:00:04Z",
    });

    // Two API requests in the turn: their usages sum, not overwrite.
    expect(turn.usage).toEqual({
      inputTokens: 80,
      outputTokens: 12,
      cacheReadTokens: 10,
      reasoningTokens: 3,
    });
  });

  it("warns when the session ends without task_complete", () => {
    const session = parseCodexTranscript(codexFixture);
    expect(session.warnings).toHaveLength(1);
    expect(session.warnings[0]).toContain("without task_complete");
  });

  it("accepts a bare-string reasoning summary (older or hand-written fixtures)", () => {
    const content = [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-01T11:00:00Z",
        payload: { type: "task_started", turn_id: "t1" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-10-01T11:00:01Z",
        payload: { type: "reasoning", summary: "Thinking plainly." },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-01T11:00:02Z",
        payload: { type: "task_complete" },
      }),
    ].join("\n");

    const [turn] = parseCodexTranscript(content).turns;
    expect(turn.thinkingText).toBe("Thinking plainly.");
  });

  it("keeps a user_message that arrives before task_started", () => {
    const content = [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-01T11:00:00Z",
        payload: { type: "user_message", message: "What files are here?" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-01T11:00:01Z",
        payload: { type: "task_started", turn_id: "t1" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-01T11:00:02Z",
        payload: { type: "task_complete" },
      }),
    ].join("\n");

    const [turn] = parseCodexTranscript(content).turns;
    expect(turn.userMessage).toBe("What files are here?");
  });
});

// ── Source detection ───────────────────────────────────────────────────────

describe("detectTranscriptSource", () => {
  it("detects claude-code from a user line's message object", () => {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
    expect(detectTranscriptSource(line)).toBe("claude-code");
  });

  it("detects claude-code from sessionId alone", () => {
    const line = JSON.stringify({ type: "user", sessionId: "sess-1", content: "hi" });
    expect(detectTranscriptSource(line)).toBe("claude-code");
  });

  it("detects codex from a payload-bearing line", () => {
    const line = JSON.stringify({ type: "event_msg", timestamp: "t", payload: { type: "task_started" } });
    expect(detectTranscriptSource(line)).toBe("codex");
  });

  it("detects codex from turn_context and response_item lines", () => {
    const turnContext = JSON.stringify({ type: "turn_context", timestamp: "t", payload: { model: "m" } });
    const responseItem = JSON.stringify({ type: "response_item", timestamp: "t", payload: { type: "reasoning" } });
    expect(detectTranscriptSource(turnContext)).toBe("codex");
    expect(detectTranscriptSource(responseItem)).toBe("codex");
  });

  it("scans past torn leading lines and non-objects", () => {
    const content = [
      '{"torn write without close',
      "[1, 2, 3]",
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    ].join("\n");
    expect(detectTranscriptSource(content)).toBe("claude-code");
  });

  it("skips a claude-code-shaped type without message or sessionId, keeps scanning", () => {
    const content = [
      JSON.stringify({ type: "user", content: "no message object" }),
      JSON.stringify({ type: "event_msg", timestamp: "t", payload: { type: "task_started" } }),
    ].join("\n");
    expect(detectTranscriptSource(content)).toBe("codex");
  });

  it("returns undefined for content with no recognizable line", () => {
    expect(detectTranscriptSource("not json at all\n")).toBeUndefined();
    expect(detectTranscriptSource("")).toBeUndefined();
  });
});

// ── OTLP translation ───────────────────────────────────────────────────────

function spansOf(payload: OtlpTracesPayload): OtlpSpan[] {
  return payload.resourceSpans[0]!.scopeSpans[0]!.spans;
}

function named(spans: OtlpSpan[], name: string): OtlpSpan[] {
  return spans.filter((span) => span.name === name);
}

function attrOf(span: OtlpSpan, key: string): string | undefined {
  const attr = span.attributes.find((candidate) => candidate.key === key);
  if (attr === undefined) return undefined;
  return attr.value.stringValue ?? attr.value.intValue;
}

describe("transcriptSessionToOtlp", () => {
  const session = parseClaudeCodeTranscript(claudeFixture);
  const payload = transcriptSessionToOtlp(session);
  const spans = spansOf(payload);

  it("emits one typed span tree per turn", () => {
    // Turn 1: interaction + llm_request + thinking + tool; turn 2: interaction + llm_request.
    expect(spans).toHaveLength(6);

    const interactions = named(spans, "claude_code.interaction");
    expect(interactions).toHaveLength(2);
    expect(attrOf(interactions[0]!, "apo.observation.type")).toBe("AGENT");

    const generations = named(spans, "claude_code.llm_request");
    expect(generations).toHaveLength(2);
    expect(attrOf(generations[0]!, "apo.observation.type")).toBe("GENERATION");
    expect(attrOf(generations[0]!, "gen_ai.request.model")).toBe("claude-sonnet-5");
    expect(attrOf(generations[0]!, "gen_ai.system")).toBe("anthropic");
    expect(attrOf(generations[0]!, "gen_ai.usage.input_tokens")).toBe("150");
    expect(attrOf(generations[0]!, "gen_ai.usage.cache_read.input_tokens")).toBe("60");
    expect(attrOf(generations[0]!, "gen_ai.usage.cache_creation.input_tokens")).toBe("30");

    const thinking = named(spans, "claude_code.thinking");
    expect(thinking).toHaveLength(1);
    expect(attrOf(thinking[0]!, "apo.observation.type")).toBe("SPAN");
    expect(attrOf(thinking[0]!, "gen_ai.output.messages")).toContain("read the file first");

    const tools = named(spans, "claude_code.tool");
    expect(tools).toHaveLength(1);
    expect(attrOf(tools[0]!, "apo.observation.type")).toBe("TOOL");
    expect(attrOf(tools[0]!, "gen_ai.tool.name")).toBe("Read");
    expect(attrOf(tools[0]!, "gen_ai.tool.call.arguments")).toContain("invoice.txt");
    expect(attrOf(tools[0]!, "gen_ai.tool.call.result")).toContain("Invoice total");
  });

  it("nests children under the turn interaction span and carries run metadata on the first root only", () => {
    const [first, second] = named(spans, "claude_code.interaction");
    const children = spans.filter((span) => span.parentSpanId === first!.spanId);
    expect(children.map((span) => span.name).sort()).toEqual([
      "claude_code.llm_request",
      "claude_code.thinking",
      "claude_code.tool",
    ]);
    expect(second!.parentSpanId).toBeUndefined();

    expect(attrOf(first!, "apo.run.flow_name")).toBe("claude-code session sess-abc");
    expect(attrOf(first!, "apo.run.tags")).toBe('["transcript-replay","claude-code"]');
    expect(attrOf(first!, "gen_ai.input.messages")).toContain("Read the invoice");
    expect(attrOf(second!, "apo.run.flow_name")).toBeUndefined();
  });

  it("derives stable, well-formed ids and timestamps", () => {
    const traceIds = new Set(spans.map((span) => span.traceId));
    expect(traceIds.size).toBe(1);
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const span of spans) {
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(
        BigInt(span.startTimeUnixNano),
      );
    }

    const again = transcriptSessionToOtlp(parseClaudeCodeTranscript(claudeFixture));
    expect(JSON.stringify(again)).toBe(JSON.stringify(payload));
  });

  it("joins a live trace: every interaction parents under parentSpanId and run metadata is suppressed", () => {
    const parented = transcriptSessionToOtlp(session, { parentSpanId: "1234567890abcdef" });
    const interactions = named(spansOf(parented), "claude_code.interaction");
    // The transcript is one session; its turns have no reliable 1:1 mapping
    // to the host run's task.turn spans, so all interactions nest under the
    // provided root. The live trace's root already carries run metadata.
    expect(interactions[0]!.parentSpanId).toBe("1234567890abcdef");
    expect(interactions[1]!.parentSpanId).toBe("1234567890abcdef");
    expect(attrOf(interactions[0]!, "apo.run.flow_name")).toBeUndefined();
    expect(attrOf(interactions[1]!, "apo.run.flow_name")).toBeUndefined();
  });
});

// ── Export ─────────────────────────────────────────────────────────────────

describe("exportOtlpTraces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the OTLP endpoint from an apo base URL", () => {
    expect(resolveOtlpTracesUrl("http://localhost:8000")).toBe(
      "http://localhost:8000/api/public/otel/v1/traces",
    );
    expect(resolveOtlpTracesUrl("http://localhost:8000/api/public/otel/v1/traces/")).toBe(
      "http://localhost:8000/api/public/otel/v1/traces",
    );
  });

  it("posts the payload with bearer auth", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = transcriptSessionToOtlp(parseClaudeCodeTranscript(claudeFixture));
    await exportOtlpTraces(payload, {
      endpoint: "http://apo.test",
      token: "tok",
      retries: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://apo.test/api/public/otel/v1/traces");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("retries a 5xx and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = transcriptSessionToOtlp(parseCodexTranscript(codexFixture));
    await exportOtlpTraces(payload, {
      endpoint: "http://apo.test",
      token: "tok",
      retries: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 rate-limit and succeeds on the next attempt", async () => {
    // apo's admission controller 429s OTLP ingest under per-key concurrency
    // pressure (the runner's own simple-processor exports can be in flight);
    // a replay POST must back off, not fail the run.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("concurrency", { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = transcriptSessionToOtlp(parseCodexTranscript(codexFixture));
    await exportOtlpTraces(payload, {
      endpoint: "http://apo.test",
      token: "tok",
      retries: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a 4xx with the status attached", async () => {
    const fetchMock = vi.fn(async () => new Response("bad token", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = transcriptSessionToOtlp(parseCodexTranscript(codexFixture));
    const error: unknown = await exportOtlpTraces(payload, {
      endpoint: "http://apo.test",
      token: "bad",
      retries: 2,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(TranscriptReplayError);
    expect((error as TranscriptReplayError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws TranscriptReplayError after exhausting retries on network failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = transcriptSessionToOtlp(parseCodexTranscript(codexFixture));
    await expect(
      exportOtlpTraces(payload, { endpoint: "http://apo.test", token: "tok", retries: 1 }),
    ).rejects.toMatchObject({
      name: "TranscriptReplayError",
      message: expect.stringContaining("ECONNREFUSED"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
