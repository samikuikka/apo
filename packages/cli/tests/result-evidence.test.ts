import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResultEvidenceTooLargeError,
  externalizeResultEvidence,
  parseResultEvidenceSupport,
  uploadResultEvidencePart,
  type ResultEvidenceUploadContext,
} from "../src/lib/result-evidence.ts";
import { prepareResultSubmission } from "../src/lib/result-submission.ts";

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseResultEvidenceSupport", () => {
  it("returns null when the server did not advertise support (old server)", () => {
    expect(parseResultEvidenceSupport({})).toBeNull();
    expect(
      parseResultEvidenceSupport({ result_evidence_supported: false }),
    ).toBeNull();
  });

  it("parses advertised limits when support is exactly true", () => {
    expect(
      parseResultEvidenceSupport({
        result_evidence_supported: true,
        result_evidence_max_item_bytes: 104_857_600,
        result_evidence_max_total_bytes: 536_870_912,
      }),
    ).toEqual({ maxItemBytes: 104_857_600, maxTotalBytes: 536_870_912 });
  });

  it("treats advertised support with malformed limits as a protocol error", () => {
    expect(() =>
      parseResultEvidenceSupport({
        result_evidence_supported: true,
        result_evidence_max_item_bytes: 0,
        result_evidence_max_total_bytes: 10,
      }),
    ).toThrow(/result_evidence_max_item_bytes/);
  });
});

describe("uploadResultEvidencePart", () => {
  const ctx: ResultEvidenceUploadContext = {
    backendUrl: "http://cp",
    attemptId: "att-1",
    authToken: "jwt-1",
    protocolVersion: 2,
  };

  afterEach(() => vi.restoreAllMocks());

  it("posts the intent with exact size and digest, then PUTs the exact bytes", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        });
        if (url.endsWith("/result-evidence")) {
          return jsonResp({ id: "rev-1", upload_url: "/v1/executor-protocol/result-evidence/rev-1" }, 201);
        }
        if (url.includes("/result-evidence/rev-1")) return jsonResp({ id: "rev-1", status: "ready" });
        return jsonResp({}, 404);
      },
    );

    const data = Buffer.from('{"messages":["hello 😀"]');
    const id = await uploadResultEvidencePart(ctx, "transcript", null, data);

    expect(id).toBe("rev-1");
    const intent = calls[0]!;
    expect(intent.url).toContain("/v1/executor-protocol/v2/attempts/att-1/result-evidence");
    expect(intent.body).toEqual({
      slot: "transcript",
      size_bytes: data.byteLength,
      sha256: sha256(data),
    });
    const put = calls[1]!;
    expect(put.method).toBe("PUT");
    expect(put.url).toContain("/v1/executor-protocol/result-evidence/rev-1");
    expect(Buffer.compare(Buffer.from(put.body as ArrayBufferLike ?? Buffer.from([])), data)).toBe(0);
  });

  it("is retry-safe after a dropped PUT: same metadata returns the same id", async () => {
    let putAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/result-evidence")) {
          // Server-side idempotency: identical metadata returns the same row.
          return jsonResp({ id: "rev-9", upload_url: "/x" }, 201);
        }
        putAttempts += 1;
        if (putAttempts === 1) throw new TypeError("fetch failed");
        return jsonResp({ id: "rev-9", status: "ready" });
      },
    );

    const data = Buffer.from('{"a":1}');
    await expect(uploadResultEvidencePart(ctx, "checks", null, data)).rejects.toThrow(
      /fetch failed/,
    );
    // A retry with identical metadata hits the same intent id and completes.
    const id = await uploadResultEvidencePart(ctx, "checks", null, data);
    expect(id).toBe("rev-9");
    expect(putAttempts).toBe(2);
  });
});

describe("externalizeResultEvidence", () => {
  const ctx: ResultEvidenceUploadContext = {
    backendUrl: "http://cp",
    attemptId: "att-1",
    authToken: "jwt-1",
    protocolVersion: 1,
  };
  const support = { maxItemBytes: 10 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 };

  afterEach(() => vi.restoreAllMocks());

  it("externalizes transcript and large deliverables until the body fits, then stops", async () => {
    const putBodies: { url: string; body: Buffer }[] = [];
    const intentBodies: Record<string, unknown>[] = [];
    let seq = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: URL | Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/result-evidence") && init?.method === "POST") {
          intentBodies.push(JSON.parse(init.body as string));
          seq += 1;
          return jsonResp(
            {
              id: `rev-${seq}`,
              upload_url: `/v1/executor-protocol/result-evidence/rev-${seq}`,
            },
            201,
          );
        }
        putBodies.push({ url, body: Buffer.from(init?.body as ArrayBufferLike) });
        return jsonResp({ status: "ready" });
      },
    );

    const bigTranscript = { messages: "x".repeat(8192) };
    const bigDoc = { clauses: "y".repeat(4096) };
    const body = {
      completion_id: "c-1",
      pass_result: true,
      transcript: bigTranscript,
      deliverables: { memo: bigDoc, tiny: { ok: true } },
      checks: [{ name: "c1", pass: true }],
    };
    const limit = 2048;
    expect(prepareResultSubmission(body, limit).overLimit).toBe(true);

    const result = await externalizeResultEvidence({ ctx, support, body, limitBytes: limit });

    // Body now fits, references the parts, and no longer embeds them.
    const prepared = prepareResultSubmission(result.body, limit);
    expect(prepared.overLimit).toBe(false);
    expect(result.body.transcript).toBeNull();
    expect(result.body.deliverables).toEqual({ tiny: { ok: true } });
    expect(Array.isArray(result.body.evidence_refs)).toBe(true);
    expect((result.body.evidence_refs as string[]).length).toBeGreaterThanOrEqual(1);

    // Transcript went first (dominant field), then the big deliverable.
    expect(intentBodies[0]).toMatchObject({ slot: "transcript" });
    expect(intentBodies[1]).toMatchObject({ slot: "deliverable", deliverable_name: "memo" });
    // Exact bytes with matching digests were PUT.
    expect(putBodies.length).toBeGreaterThanOrEqual(1);
    const firstPut = putBodies[0]!;
    expect(sha256(firstPut.body)).toBe((intentBodies[0] as { sha256: string }).sha256);
  });

  it("also externalizes checks when transcript and deliverables are not enough", async () => {
    let seq = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/result-evidence") && init?.method === "POST") {
        seq += 1;
        return jsonResp(
          { id: `rev-${seq}`, upload_url: `/v1/executor-protocol/result-evidence/rev-${seq}` },
          201,
        );
      }
      return jsonResp({ status: "ready" });
    });

    const checks = Array.from({ length: 400 }, (_, i) => ({
      name: `c${i}`,
      pass: true,
      reasoning: "z".repeat(64),
    }));
    const body = {
      completion_id: "c-2",
      pass_result: false,
      transcript: { messages: "x".repeat(1024) },
      checks,
    };
    const limit = 512;
    const result = await externalizeResultEvidence({ ctx, support, body, limitBytes: limit });
    expect(prepareResultSubmission(result.body, limit).overLimit).toBe(false);
    expect(result.body.checks).toBeNull();
  });

  it("throws ResultEvidenceTooLargeError when a single part exceeds the item cap", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResp({}));

    const body = {
      completion_id: "c-3",
      pass_result: true,
      transcript: { messages: "x".repeat(50_000) },
    };
    const tinySupport = { maxItemBytes: 1024, maxTotalBytes: 10_000_000 };
    await expect(
      externalizeResultEvidence({ ctx, support: tinySupport, body, limitBytes: 512 }),
    ).rejects.toThrow(ResultEvidenceTooLargeError);
  });
});

describe("externalizeResultEvidence boundary (issue #251 adversarial review)", () => {
  const ctx: ResultEvidenceUploadContext = {
    backendUrl: "http://cp",
    attemptId: "att-1",
    authToken: "jwt-1",
    protocolVersion: 1,
  };
  const support = { maxItemBytes: 10 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 };

  afterEach(() => vi.restoreAllMocks());

  function mockUpload(): void {
    let seq = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/result-evidence") && init?.method === "POST") {
        seq += 1;
        return jsonResp(
          { id: `rev-${seq}`, upload_url: `/v1/executor-protocol/result-evidence/rev-${seq}` },
          201,
        );
      }
      return jsonResp({ status: "ready" });
    });
  }

  it("counts the evidence_refs overhead: the returned body as sent never exceeds the limit", async () => {
    mockUpload();

    // Craft the exact boundary the review demonstrated: after removing the
    // transcript, the remaining body fits with only ~a dozen bytes of slack,
    // so the attached ref id — which the old measurement ignored — would
    // push the serialized result over the cap.
    const filler = "x".repeat(2_000);
    const body = {
      completion_id: "c-boundary",
      pass_result: true,
      transcript: { messages: "y".repeat(8_000) },
      checks: [{ name: "c1", pass: true }],
      stdout_tail: filler,
    };
    const probe = { ...body, transcript: null, evidence_refs: [] as string[] };
    const restBytes = Buffer.byteLength(JSON.stringify(probe), "utf8");
    const limit = restBytes + 12; // less slack than `"evidence_refs":["rev-1"]` costs

    const result = await externalizeResultEvidence({ ctx, support, body, limitBytes: limit });

    // The exact body the caller would serialize and send fits.
    expect(
      Buffer.byteLength(JSON.stringify({ ...result.body }), "utf8"),
    ).toBeLessThanOrEqual(limit);
    expect((result.body.evidence_refs as string[]).length).toBeGreaterThanOrEqual(1);
    expect(result.body.transcript).toBeNull();
  });
});
