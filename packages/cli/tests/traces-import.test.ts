import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";

import { run } from "../src/commands/traces-import.ts";

// Credentials resolution reads ~/.apo/credentials — pin it to "none" so tests
// are deterministic on machines with a real login stored.
vi.mock("../src/lib/credentials.ts", () => ({
  readCredentials: () => null,
  credentialsPath: () => "/nonexistent/apo-credentials.json",
}));

const TMP = join(import.meta.dirname, "__traces_import_test__");

const CLAUDE_FIXTURE = [
  JSON.stringify({
    type: "user",
    sessionId: "cli-import-1",
    cwd: "/tmp/cli",
    timestamp: "2026-10-01T16:00:00Z",
    message: { role: "user", content: "Read the invoice." },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T16:00:05Z",
    message: {
      id: "m1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "tool_use",
      usage: { input_tokens: 40, output_tokens: 5 },
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "invoice.txt" } }],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-10-01T16:00:06Z",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Total: 100 EUR" }] },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T16:00:09Z",
    message: {
      id: "m1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 8 },
      content: [{ type: "text", text: "The total is 100 EUR." }],
    },
  }),
].join("\n");

const CODEX_FIXTURE = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-10-01T16:10:00Z",
    payload: { id: "codex-cli-1", cwd: "/tmp/codex-cli" },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-10-01T16:10:01Z",
    payload: { model: "gpt-5.4", cwd: "/tmp/codex-cli" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T16:10:01Z",
    payload: { type: "task_started" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T16:10:02Z",
    payload: { type: "user_message", message: "List files." },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T16:10:05Z",
    payload: { type: "agent_message", phase: "final_answer", message: "Two files." },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-01T16:10:05Z",
    payload: { type: "task_complete" },
  }),
].join("\n");

type CapturedPost = { url: string; body: unknown; auth: string | null };

function captureLog(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function okBackend(posts: CapturedPost[]): (url: unknown, init?: RequestInit) => Promise<Response> {
  return async (url: unknown, init?: RequestInit) => {
    const href = typeof url === "string" ? url : "";
    if (href.endsWith("/api/public/otel/v1/traces")) {
      posts.push({
        url: href,
        body: JSON.parse(String(init?.body)) as unknown,
        auth: new Headers(init?.headers).get("Authorization"),
      });
      return new Response(null, { status: 200 });
    }
    if (href.includes("/v1/runs/")) {
      return Response.json({
        run: {
          id: href.split("/").pop(),
          project: "demo",
          flow_name: "imported",
          primary_model: "claude-sonnet-5",
          call_count: 4,
        },
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
}

function spansOf(post: CapturedPost): Array<Record<string, unknown>> {
  const payload = post.body as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
  };
  return payload.resourceSpans[0]!.scopeSpans[0]!.spans;
}

let claudeFile: string;
let codexFile: string;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  claudeFile = join(TMP, "claude-session.jsonl");
  codexFile = join(TMP, "codex-rollout.jsonl");
  writeFileSync(claudeFile, CLAUDE_FIXTURE, "utf-8");
  writeFileSync(codexFile, CODEX_FIXTURE, "utf-8");
  delete process.env.APO_PUBLIC_KEY;
  delete process.env.APO_SECRET_KEY;
  delete process.env.APO_AUTH_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(TMP, { recursive: true, force: true });
});

describe("traces import", () => {
  it("imports a claude-code transcript with auto-detection and prints the dashboard path", async () => {
    const posts: CapturedPost[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(okBackend(posts));
    const { logs, restore } = captureLog();
    try {
      const code = await run([
        claudeFile,
        "--backend",
        "http://apo.test",
        "--api-key",
        "cli-key",
      ]);
      expect(code).toBe(0);
    } finally {
      restore();
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("http://apo.test/api/public/otel/v1/traces");
    expect(posts[0]!.auth).toBe("Bearer cli-key");
    const spans = spansOf(posts[0]!);
    expect(spans.map((s) => s.name)).toContain("claude_code.tool");
    const traceId = spans[0]!.traceId as string;
    expect(logs.join("\n")).toContain(traceId);
    expect(logs.join("\n")).toContain(`/project/demo/traces/${traceId}`);
  });

  it("imports a codex transcript with explicit --source and --tag", async () => {
    const posts: CapturedPost[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(okBackend(posts));
    const { restore } = captureLog();
    try {
      const code = await run([
        codexFile,
        "--source",
        "codex",
        "--tag",
        "production",
        "--name",
        "codex incident",
        "--backend",
        "http://apo.test",
        "--api-key",
        "cli-key",
      ]);
      expect(code).toBe(0);
    } finally {
      restore();
    }

    const spans = spansOf(posts[0]!);
    expect(spans.map((s) => s.name)).toContain("codex.llm_request");
    const root = spans.find((s) => s.name === "codex.interaction") as {
      attributes: Array<{ key: string; value: { stringValue?: string } }>;
    };
    const tags = root.attributes.find((a) => a.key === "apo.run.tags");
    expect(tags?.value.stringValue).toBe('["production"]');
    const flow = root.attributes.find((a) => a.key === "apo.run.flow_name");
    expect(flow?.value.stringValue).toBe("codex incident");
  });

  it("emits machine-readable output with --json", async () => {
    const posts: CapturedPost[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(okBackend(posts));
    const { logs, restore } = captureLog();
    try {
      const code = await run([
        claudeFile,
        "--json",
        "--backend",
        "http://apo.test",
        "--api-key",
        "cli-key",
      ]);
      expect(code).toBe(0);
    } finally {
      restore();
    }
    const parsed = JSON.parse(logs.join("")) as Array<{ source: string; turns: number }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.source).toBe("claude-code");
    expect(parsed[0]!.turns).toBe(1);
  });

  it("fails with exit 1 on an auth rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const href = typeof url === "string" ? url : "";
      if (href.endsWith("/api/public/otel/v1/traces")) {
        return new Response('{"detail":"bad key"}', { status: 401 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const { errors, restore } = captureLog();
    try {
      const code = await run([claudeFile, "--backend", "http://apo.test", "--api-key", "bad"]);
      expect(code).toBe(1);
    } finally {
      restore();
    }
    expect(errors.join("\n")).toContain("401");
  });

  it("fails on an unrecognized format", async () => {
    const mystery = join(TMP, "mystery.jsonl");
    writeFileSync(mystery, '{"hello":"world"}\n', "utf-8");
    const { errors, restore } = captureLog();
    try {
      const code = await run([mystery, "--backend", "http://apo.test", "--api-key", "k"]);
      expect(code).toBe(1);
    } finally {
      restore();
    }
    expect(errors.join("\n")).toContain("could not detect");
  });

  it("fails fast without credentials", async () => {
    const { errors, restore } = captureLog();
    try {
      const code = await run([claudeFile, "--backend", "http://apo.test"]);
      expect(code).toBe(1);
    } finally {
      restore();
    }
    expect(errors.join("\n")).toContain("No credentials");
  });
});
