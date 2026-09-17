/**
 * Issue #298: `resolveRunId` decided "full id vs prefix" by length (< 32).
 * Canonical run ids are `run_` + 24 hex = 28 chars, so every complete id
 * took the prefix path — which only searches the backend's default listing
 * window (1000 most recent runs) — and a local miss threw a fabricated
 * `Backend error 404` that read like a server rejection of the id.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRunId, resolveRunIdByPrefix } from "../src/lib/runs-resolve.ts";
import { resolveBatchId } from "../src/lib/batch-resolve.ts";
import type { Config } from "../src/lib/config.ts";

const CANONICAL_RUN_ID = "run_7e99888dfb3dd44e7f0fb197"; // run_ + 24 hex = 28 chars
const CANONICAL_BATCH_ID = "bch_0123456789abcdef01234567"; // bch_ + 24 hex = 28 chars
const LEGACY_ID = "0123456789abcdef0123456789abcdef"; // pre-canonical 32-char id

function testConfig(): Config {
  return {
    taskRoot: "./e2e",
    backendUrl: "http://backend.test",
    projectId: undefined,
    actor: undefined,
    apiKey: "test-key",
    json: false,
    ci: false,
    _rawFlags: {},
  };
}

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveRunId full-id recognition (issue #298)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a canonical 28-char run id directly without listing runs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const id = await resolveRunId(
      "http://backend.test",
      CANONICAL_RUN_ID,
      testConfig(),
    );

    expect(id).toBe(CANONICAL_RUN_ID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still passes legacy ids of 32+ chars through verbatim", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const id = await resolveRunId("http://backend.test", LEGACY_ID, testConfig());

    expect(id).toBe(LEGACY_ID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a short prefix against the run list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([{ id: CANONICAL_RUN_ID }]),
    );

    const id = await resolveRunId("http://backend.test", "run_7e99", testConfig());

    expect(id).toBe(CANONICAL_RUN_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/agent-task-runs");
  });

  it("does not fabricate a backend 404 when a prefix matches nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse([]));

    const error = await resolveRunIdByPrefix(
      "http://backend.test",
      "run_deadbee",
      testConfig(),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // No request for the id itself was made, so the error must not read as
    // one — the old message was `Backend error 404: {"detail":"Run not found"}`.
    expect(message).not.toContain("Backend error");
    expect(message).not.toContain("404");
    expect(message).toContain("run_deadbee");
    expect(message).toMatch(/full run id/i);
  });

  it("still reports ambiguous prefixes with the matching ids", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([
        { id: "run_7e99888dfb3dd44e7f0fb197" },
        { id: "run_7e99aaaa00000000f0fb197" },
      ]),
    );

    const error = await resolveRunIdByPrefix(
      "http://backend.test",
      "run_7e99",
      testConfig(),
    ).catch((e: unknown) => e);

    expect((error as Error).message).toContain("matches multiple runs");
    expect((error as Error).message).toContain(CANONICAL_RUN_ID);
  });
});

describe("resolveBatchId full-id recognition (issue #298)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a canonical 28-char batch id directly without listing batches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const id = await resolveBatchId(
      "http://backend.test",
      CANONICAL_BATCH_ID,
      testConfig(),
    );

    expect(id).toBe(CANONICAL_BATCH_ID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a short prefix against the batch list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ data: [{ id: CANONICAL_BATCH_ID }] }),
    );

    const id = await resolveBatchId(
      "http://backend.test",
      "bch_0123",
      testConfig(),
    );

    expect(id).toBe(CANONICAL_BATCH_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/agent-task-batch-runs");
  });

  it("does not fabricate a backend 404 when a prefix matches nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse({ data: [] }));

    const error = await resolveBatchId(
      "http://backend.test",
      "bch_deadbee",
      testConfig(),
    ).catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).not.toContain("Backend error");
    expect(message).not.toContain("404");
    expect(message).toContain("bch_deadbee");
    expect(message).toMatch(/full batch id/i);
  });
});
