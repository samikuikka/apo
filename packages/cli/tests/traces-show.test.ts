import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../src/lib/format.ts";

/**
 * Regression test for traces-show not forwarding the project query param.
 *
 * The traces-show command hits GET /v1/runs/{id}. The backend defaults
 * project to "default" when no ?project= param is sent, so traces belonging
 * to any other project 404. The fix: forward config.projectId as ?project=,
 * same as traces-list does.
 */

const FULL_ID = "0123456789abcdef0123456789abcdef";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return { errors, restore: () => { console.error = original; } };
}

function makeTraceDetail(): Record<string, unknown> {
  return {
    run: {
      id: FULL_ID,
      task_id: "data-extraction",
      flow_name: "agent-task.data-extraction",
      status: "success",
      duration_ms: 5000,
      environment: "default",
      tags: [],
      created_at: "2026-07-14T18:12:37Z",
      completed_at: "2026-07-14T18:12:42Z",
    },
    calls: [],
    metrics: [],
  };
}

describe("traces show command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the project query param when projectId is set", async () => {
    const { run } = await import("../src/commands/traces-show.ts");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeTraceDetail()),
    );

    await run([FULL_ID, "--backend", "http://backend.test", "--project", "my-project"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/runs/");
    expect(url).toContain("project=my-project");
  });

  it("returns 404 error when trace is not found", async () => {
    const { run } = await import("../src/commands/traces-show.ts");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ detail: "Run not found" }, 404),
    );
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--project", "my-project"]);
    restore();

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Trace not found");
  });
});

describe("traces show model column", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never truncates model names — column sizes to the longest model", async () => {
    // Regression: the model column was hard-sliced to 22 chars, so
    // google/gemini-2.5-flash-lite printed as google/gemini-2.5-flas.
    const longModel = "openrouter/google/gemini-2.5-flash-lite-preview";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse({
        run: { id: FULL_ID, status: "success", created_at: "2026-06-29T10:00:00Z" },
        calls: [
          { id: "c1", level: "INFO", step_name: "ai.generateText", model: longModel, latency_ms: 900, cost: 0.0001, total_tokens: 100 },
          { id: "c2", level: "INFO", step_name: "task.turn", model: "gpt-5.6", latency_ms: 100, cost: null, total_tokens: null },
        ],
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain(longModel);
  });
});

describe("traces show evidence + attributes (issue #164)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the projection's evidence capabilities in the header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({
        ...makeTraceDetail(),
        capabilities: {
          messages: "available",
          tools: "available",
          errors: "available",
          timing: "available",
          skills: "unavailable",
          subagents: "unavailable",
        },
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Evidence:");
    expect(out).toContain("skills:unavailable");
    expect(out).toContain("tools:available");
  });

  it("verbose requests raw span attributes and renders them with the resolved type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({
        ...makeTraceDetail(),
        calls: [
          {
            id: "c1", level: "DEFAULT", step_name: "read_file", observation_type: "SKILL",
            model: null, latency_ms: 12, cost: null, total_tokens: null,
            attributes: { "apo.observation.type": "SKILL", "gen_ai.tool.name": "read_file" },
          },
        ],
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--verbose"]);
    restore();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("include=messages%2Cattributes");

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("type: SKILL");
    expect(out).toContain("apo.observation.type");
  });
});

describe("traces show content caps (issue #308)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A reply long enough that both default previews cut it (300 per message,
  // 500 for output) — shorter fixtures would leak the tail via `output:`.
  const LONG_REPLY = `[thinking] ${"reasoning ".repeat(80)}final answer: ship it`;
  const REPLY_TAIL = "final answer: ship it";

  function makeCall(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      level: "DEFAULT",
      step_name: "ai.generateText",
      observation_type: "GENERATION",
      model: "test-model",
      latency_ms: 500,
      cost: 0.0001,
      total_tokens: 42,
      messages: [{ role: "assistant", content: LONG_REPLY }],
      output: LONG_REPLY,
      ...overrides,
    };
  }

  it("default verbose preview cuts a message at 300 chars", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ ...makeTraceDetail(), calls: [makeCall("call-1")] }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--verbose"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain(`[assistant] ${LONG_REPLY.slice(0, 300)}`);
    // Upper bound: without it the test passes for any cap in [300, 811) —
    // a regression that drops the cap wiring entirely stays invisible.
    expect(out).not.toContain(`[assistant] ${LONG_REPLY.slice(0, 301)}`);
    expect(out).not.toContain(REPLY_TAIL);
    // Verbose call lines carry the call id — it's what --call selects on.
    expect(out).toContain("call-1");
  });

  it("--full prints the whole message and output without truncation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ ...makeTraceDetail(), calls: [makeCall("call-1")] }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--full"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain(REPLY_TAIL);
    expect(out).toContain(`output:`);
    expect(out).toContain(LONG_REPLY);
    // --full implies the verbose view, so messages are requested at all.
    expect(out).toContain("messages:");
  });

  it("--full requests messages from the backend without an explicit --verbose", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ ...makeTraceDetail(), calls: [makeCall("call-1")] }),
    );
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--full"]);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("include=messages%2Cattributes");
  });

  it("--max-chars caps the message at the given size", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ ...makeTraceDetail(), calls: [makeCall("call-1")] }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--max-chars", "60"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain(`[assistant] ${LONG_REPLY.slice(0, 60)}`);
    // Upper bound pins the cap at exactly 60 — without it the default 300
    // would satisfy both assertions and a dead --max-chars would pass.
    expect(out).not.toContain(`[assistant] ${LONG_REPLY.slice(0, 61)}`);
    expect(out).not.toContain(REPLY_TAIL);
  });

  it("--full prints the whole input when a call has no messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({
        ...makeTraceDetail(),
        calls: [makeCall("call-1", { messages: null, input: { prompt: LONG_REPLY } })],
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--full"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("input:");
    expect(out).toContain(REPLY_TAIL);
  });

  it("accepts --full=true and --max-chars=100 inline forms", async () => {
    // Fresh Response per call — a Response body can only be read once.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse({ ...makeTraceDetail(), calls: [makeCall("call-1")] }),
    );
    const { run } = await import("../src/commands/traces-show.ts");

    const uncapped = captureLog();
    await run([FULL_ID, "--backend", "http://backend.test", "--full=true"]);
    uncapped.restore();
    const uncappedOut = stripAnsi(uncapped.logs.join("\n"));
    expect(uncappedOut).toContain(REPLY_TAIL); // --full=true lifted the caps

    const capped = captureLog();
    await run([FULL_ID, "--backend", "http://backend.test", "--max-chars=100"]);
    capped.restore();
    const cappedOut = stripAnsi(capped.logs.join("\n"));
    expect(cappedOut).toContain(`[assistant] ${LONG_REPLY.slice(0, 100)}`);
    expect(cappedOut).not.toContain(`[assistant] ${LONG_REPLY.slice(0, 101)}`);
  });

  it("rejects --max-chars junk and the --full combination before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { run } = await import("../src/commands/traces-show.ts");

    await expect(run([FULL_ID, "--backend", "http://backend.test", "--max-chars", "lots"]))
      .rejects.toThrow("--max-chars requires a positive integer");
    await expect(run([FULL_ID, "--backend", "http://backend.test", "--max-chars"]))
      .rejects.toThrow("--max-chars requires a positive integer");
    await expect(run([FULL_ID, "--backend", "http://backend.test", "--full", "--max-chars", "100"]))
      .rejects.toThrow("mutually exclusive");
    await expect(run([FULL_ID, "--backend", "http://backend.test", "--call"]))
      .rejects.toThrow("--call requires a call id");
    // `--call=` parses to an empty string, not boolean true — it must be
    // rejected too, or it silently matches every call id as a prefix.
    await expect(run([FULL_ID, "--backend", "http://backend.test", "--call="]))
      .rejects.toThrow("--call requires a call id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("--call prints only the selected generation, untruncated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({
        ...makeTraceDetail(),
        calls: [
          makeCall("aaa1", { step_name: "first-generation", messages: [{ role: "assistant", content: "short one" }] }),
          makeCall("bbb2", { step_name: "second-generation" }),
        ],
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--call", "bbb"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("second-generation");
    expect(out).toContain(REPLY_TAIL);
    expect(out).not.toContain("first-generation");
    expect(out).not.toContain("short one");
  });

  it("--call reports unknown and ambiguous prefixes with exit code 2", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse({
        ...makeTraceDetail(),
        calls: [makeCall("aaa1"), makeCall("aaa2")],
      }),
    );
    const { run } = await import("../src/commands/traces-show.ts");

    const miss = captureError();
    const missCode = await run([FULL_ID, "--backend", "http://backend.test", "--call", "zzz"]);
    miss.restore();
    expect(missCode).toBe(2);
    expect(miss.errors.join("\n")).toContain("Call not found: zzz");

    const ambiguous = captureError();
    const ambiguousCode = await run([FULL_ID, "--backend", "http://backend.test", "--call", "aaa"]);
    ambiguous.restore();
    expect(ambiguousCode).toBe(2);
    expect(ambiguous.errors.join("\n")).toContain("matches 2 calls");
    expect(ambiguous.errors.join("\n")).toContain("aaa1");
    expect(ambiguous.errors.join("\n")).toContain("aaa2");
  });

  it("--call wins over --errors-only and composes with --max-chars", async () => {
    // Fresh Response per call — a Response body can only be read once.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse({
        ...makeTraceDetail(),
        calls: [
          makeCall("aaa1", { level: "ERROR", step_name: "the-error" }),
          makeCall("bbb2", { step_name: "second-generation" }),
        ],
      }),
    );
    const { run } = await import("../src/commands/traces-show.ts");

    // A DEFAULT-level call still prints: naming the call beats the filter.
    const filtered = captureLog();
    await run([FULL_ID, "--backend", "http://backend.test", "--call", "bbb", "--errors-only"]);
    filtered.restore();
    const filteredOut = stripAnsi(filtered.logs.join("\n"));
    expect(filteredOut).toContain("second-generation");
    expect(filteredOut).not.toContain("the-error");
    expect(filteredOut).toContain(REPLY_TAIL); // --call alone: no cap

    // Explicit --max-chars overrides --call's implied no-cap default.
    const capped = captureLog();
    await run([FULL_ID, "--backend", "http://backend.test", "--call", "bbb", "--max-chars", "40"]);
    capped.restore();
    const cappedOut = stripAnsi(capped.logs.join("\n"));
    expect(cappedOut).toContain(`[assistant] ${LONG_REPLY.slice(0, 40)}`);
    expect(cappedOut).not.toContain(`[assistant] ${LONG_REPLY.slice(0, 41)}`);
    expect(cappedOut).not.toContain(REPLY_TAIL);
  });

  it("bare --json still requests messages and attributes", async () => {
    // --json is the everything-mode: the raw dump must carry the content the
    // text view previews, so it opts into the heavy include params too.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ ...makeTraceDetail(), calls: [makeCall("call-1")] }),
    );
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--json"]);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("include=messages%2Cattributes");
  });

  it("--json stays the full raw trace even with --call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({
        ...makeTraceDetail(),
        calls: [makeCall("aaa1"), makeCall("bbb2")],
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--call", "bbb", "--json"]);
    restore();

    expect(code).toBe(0);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("aaa1");
    expect(out).toContain("bbb2");
  });
});
