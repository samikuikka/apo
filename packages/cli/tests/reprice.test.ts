import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/reprice.ts";

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
  return { logs, restore: () => {
    console.log = original;
  } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return { errors, restore: () => {
    console.error = original;
  } };
}

const SUMMARY = {
  repriced: 12437,
  skipped_provided: 0,
  skipped_no_usage: 3201,
  skipped_no_match: 14,
  net_delta: 1_203_440_000, // micro-USD
};

describe("reprice command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kicks off then polls, prints the summary", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // POST /v1/admin/reprice -> job_id
      .mockResolvedValueOnce(mockResponse({ job_id: "abc123" }))
      // GET poll -> done
      .mockResolvedValueOnce(
        mockResponse({ job_id: "abc123", status: "done", summary: SUMMARY, error: null }),
      );

    const { logs, restore } = captureLog();
    const code = await run([
      "--backend",
      "http://backend.test",
      "--admin-key",
      "secret",
    ]);
    restore();

    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // First call is the POST kick-off with the admin key header.
    const postCall = fetchSpy.mock.calls[0];
    expect(postCall?.[1]?.method).toBe("POST");
    expect(postCall?.[1]?.headers).toMatchObject({ "x-admin-key": "secret" });
    // Summary line reports the repriced count.
    expect(logs.join("\n")).toContain("Repriced 12437 calls");
    expect(logs.join("\n")).toContain("Skipped: 3201");
  });

  it("exits non-zero when the backend is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test", "--admin-key", "k"]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Cannot connect");
  });

  it("reports a job error from polling", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ job_id: "xyz" }))
      .mockResolvedValueOnce(
        mockResponse({
          job_id: "xyz",
          status: "error",
          summary: null,
          error: "boom",
        }),
      );
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test", "--admin-key", "k"]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("boom");
  });

  it("emits JSON when --json", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ job_id: "j1" }))
      .mockResolvedValueOnce(
        mockResponse({ job_id: "j1", status: "done", summary: SUMMARY, error: null }),
      );
    const { logs, restore } = captureLog();

    const code = await run([
      "--backend",
      "http://backend.test",
      "--admin-key",
      "k",
      "--json",
    ]);
    restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.summary.repriced).toBe(12437);
  });

  it("rejects a non-integer --model-id instead of broadening the reprice", async () => {
    // Regression (audit P1 #5): Number("abc") -> NaN -> JSON null -> no filter,
    // which would reprice EVERY call. Must error instead.
    const { errors, restore } = captureError();
    const code = await run([
      "--backend",
      "http://backend.test",
      "--admin-key",
      "k",
      "--model-id",
      "abc",
    ]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("--model-id must be an integer");
  });

  it("reports a job error in --json mode (exit 2, not silent success)", async () => {
    // Regression (audit P1 #5): --json must surface an error status, not
    // silently succeed.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ job_id: "jerr" }))
      .mockResolvedValueOnce(
        mockResponse({ job_id: "jerr", status: "error", summary: null, error: "db locked" }),
      );
    const { errors, restore } = captureError();

    const code = await run([
      "--backend",
      "http://backend.test",
      "--admin-key",
      "k",
      "--json",
    ]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("db locked");
  });
});
