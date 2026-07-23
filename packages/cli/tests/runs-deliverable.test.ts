import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-deliverable.ts";
import { stripAnsi } from "../src/lib/format.ts";

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

function makeRun(deliverables: Record<string, unknown> | null): Record<string, unknown> {
  return { id: FULL_ID, deliverables_json: deliverables };
}

describe("runs deliverable command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a manifest (name + type + size) when no deliverable name is given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          memorandum: "M".repeat(20_000),
          summary: "a short summary",
          stats: { passes: 3, fails: 1 },
        }),
      ),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://backend.test/v1/agent-task-runs/${FULL_ID}`,
    );
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("memorandum");
    expect(out).toContain("20,000 chars");
    expect(out).toContain("summary");
    expect(out).toContain("stats");
    expect(out).toContain("object");
    // Full content is NOT dumped in manifest mode.
    expect(out).not.toContain("M".repeat(100));
  });

  it("prints a single deliverable's full content when named", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ memorandum: "THE FULL MEMO BODY" })),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "memorandum", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("THE FULL MEMO BODY");
  });

  it("exits 2 and lists available deliverables when the name is unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ memorandum: "x", summary: "y" })),
    );
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "missing", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    const out = stripAnsi(errors.join("\n"));
    expect(out).toContain('"missing"');
    expect(out).toContain("memorandum");
    expect(out).toContain("summary");
  });

  it("exits 2 with a usage hint when run-id is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stripAnsi(errors.join("\n"))).toMatch(/run-id|usage/i);
  });

  it("reports no deliverables cleanly (exit 0)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse(makeRun(null)));
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(stripAnsi(errors.join("\n"))).toMatch(/no deliverables/i);
  });

  it("returns exit code 2 when the run is not found (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse({ detail: "not found" }, 404));
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(stripAnsi(errors.join("\n"))).toContain("Run not found");
  });

  it("resolves 'last' to the latest run before fetching deliverables", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(mockResponse([{ id: FULL_ID }]))
      .mockResolvedValueOnce(mockResponse(makeRun({ summary: "s" })));
    const { logs, restore } = captureLog();

    const code = await run(["last", "summary", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=1");
    expect(logs.join("\n")).toContain("s");
  });

  it("emits a JSON manifest with --json", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ memorandum: "M".repeat(20_000), summary: "s" })),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--json"]);
    restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.memorandum).toMatchObject({ type: "string", chars: 20_000 });
    expect(parsed.summary).toMatchObject({ type: "string", chars: 1 });
  });

  it("emits the raw deliverable value with --json <name>", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ stats: { passes: 3, fails: 1 } })),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "stats", "--backend", "http://backend.test", "--json"]);
    restore();

    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toEqual({ passes: 3, fails: 1 });
  });
});
