import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESULT_MAX_BYTES,
  ResultSubmissionHttpError,
  boundedResponseDetail,
  formatResultTooLarge,
  parseAdvertisedResultMaxBytes,
  prepareResultSubmission,
} from "../src/lib/result-submission.ts";

describe("parseAdvertisedResultMaxBytes", () => {
  it("falls back to the documented default when the field is missing (old caller server)", () => {
    expect(parseAdvertisedResultMaxBytes(undefined)).toBe(10_485_760);
    expect(parseAdvertisedResultMaxBytes(null)).toBe(10_485_760);
    expect(DEFAULT_RESULT_MAX_BYTES).toBe(10_485_760);
  });

  it("accepts positive integers and integer-valued strings", () => {
    expect(parseAdvertisedResultMaxBytes(2048)).toBe(2048);
    expect(parseAdvertisedResultMaxBytes("4096")).toBe(4096);
  });

  it("rejects malformed limits as protocol errors, never as unlimited", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "abc", "", {}, true, []]) {
      expect(() => parseAdvertisedResultMaxBytes(bad)).toThrow(/invalid result_max_bytes/);
    }
  });
});

describe("prepareResultSubmission exact bytes", () => {
  it("counts full envelope UTF-8 bytes, not JS string length", () => {
    // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes; the envelope adds braces,
    // quotes, and a colon that field sizes alone do not cover.
    const body = { a: "é".repeat(1000) };
    const prepared = prepareResultSubmission(body, Number.MAX_SAFE_INTEGER);
    expect(prepared.size.totalBytes).toBe(Buffer.byteLength(JSON.stringify(body), "utf8"));
    expect(prepared.size.totalBytes).toBeGreaterThan(2000);
    // And the serialized payload is exactly what was measured.
    expect(Buffer.byteLength(prepared.serialized, "utf8")).toBe(prepared.size.totalBytes);
  });

  it("measures multibyte emoji bodies exactly at the boundary", () => {
    // 4-byte emoji: build a body whose serialized form is exactly 100 bytes.
    // envelope: {"a":"…"} → 8 bytes of structure + 4n = 100 → n = 23.
    const body = { a: "😀".repeat(23) };
    const atCap = prepareResultSubmission(body, 100);
    expect(atCap.size.totalBytes).toBe(100);
    expect(atCap.overLimit).toBe(false);
    const over = prepareResultSubmission({ a: "😀".repeat(24) }, 100);
    expect(over.size.totalBytes).toBe(104);
    expect(over.overLimit).toBe(true);
  });

  it("is at-limit safe: cap passes, cap+1 fails", () => {
    const filler = "x".repeat(30);
    // {"a":"xxx…"} = 8 structure bytes + 30 = 38.
    const body = { a: filler };
    expect(prepareResultSubmission(body, 38).overLimit).toBe(false);
    expect(prepareResultSubmission(body, 37).overLimit).toBe(true);
  });

  it("records explanatory per-field bytes that need not sum to the total", () => {
    const body = { checks: [1, 2, 3], transcript: { t: "x" } };
    const { size } = prepareResultSubmission(body, 1000);
    expect(size.fields.checks).toBe(Buffer.byteLength("[1,2,3]", "utf8"));
    expect(size.fields.transcript).toBe(Buffer.byteLength('{"t":"x"}', "utf8"));
    const fieldSum = Object.values(size.fields).reduce((a, b) => a + b, 0);
    expect(fieldSum).toBeLessThan(size.totalBytes); // keys/separators contribute
  });
});

describe("formatResultTooLarge", () => {
  it("begins with result_too_large and names bytes, limit, and largest fields", () => {
    const message = formatResultTooLarge({
      totalBytes: 12_345,
      limitBytes: 10_000,
      fields: { transcript: 9_000, checks: 2_000, deliverables: 1_000, pass_result: 4 },
    });
    expect(message.startsWith("result_too_large:")).toBe(true);
    expect(message).toContain("total_bytes=12345");
    expect(message).toContain("limit_bytes=10000");
    expect(message).toContain("transcript=9000");
    expect(message).toContain("checks=2000");
    // Largest three only — the smallest field is dropped.
    expect(message).not.toContain("pass_result");
  });
});

describe("ResultSubmissionHttpError", () => {
  it("preserves the HTTP status for definite-rejection classification", () => {
    const err = new ResultSubmissionHttpError(413, "Request body exceeds the 10485760 byte limit");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(413);
    expect(err.message).toContain("413");
    expect(err.message).toContain("exceeds");
  });

  it("boundedResponseDetail truncates long responses and survives unreadable bodies", async () => {
    const long = new Response("x".repeat(1_000));
    const detail = await boundedResponseDetail(long, 50);
    expect(detail.length).toBeLessThanOrEqual(51); // 50 chars + ellipsis
    expect(detail.endsWith("…")).toBe(true);
    const broken = new Response("");
    broken.text = () => Promise.reject(new Error("body gone"));
    await expect(boundedResponseDetail(broken)).resolves.toBe("");
  });

  it("boundedResponseDetail never grows without bound for HTML proxy errors", async () => {
    const html = new Response("<html>" + "<div>proxy</div>".repeat(500) + "</html>", { status: 413 });
    const detail = await boundedResponseDetail(html);
    expect(detail.length).toBeLessThanOrEqual(301);
  });
});
