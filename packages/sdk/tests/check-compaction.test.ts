import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  compactChecksForSubmission,
  JUDGE_SEGMENT_LIMIT,
  RECEIVED_VALUE_LIMIT,
} from "../src/agent-task/public.ts";
import type { EvaluationItemResult } from "../src/agent-task/public.ts";

/** The backend's canonical encoding: compact JSON over UTF-8 bytes. */
function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function judgedCheck(received: unknown): EvaluationItemResult {
  return {
    id: "criterion-1",
    pass: true,
    reasoning: "looks fine",
    assertions: [
      { id: "judge", pass: true, reasoning: "ok", received, evaluator_type: "llm" },
    ],
  };
}

describe("compactChecksForSubmission (issue #175)", () => {
  it("replaces an oversized received with the backend's truncation marker", () => {
    const value = "x".repeat(RECEIVED_VALUE_LIMIT + 1);
    const { checks, truncatedValues } = compactChecksForSubmission([judgedCheck(value)]);

    const received = checks[0].assertions![0].received as Record<string, unknown>;
    expect(truncatedValues).toBe(1);
    expect(received.kind).toBe("truncated");
    // The preview covers the canonical JSON encoding, quotes included —
    // exactly what the backend's marker over the same value contains.
    expect(received.preview).toBe(JSON.stringify(value).slice(0, 256));
    expect(received.size_bytes).toBe(canonicalBytes(value).length);
    expect(received.sha256).toBe(createHash("sha256").update(canonicalBytes(value)).digest("hex"));
  });

  it("passes small values through untouched", () => {
    const small = "fine";
    const { checks, truncatedValues } = compactChecksForSubmission([judgedCheck(small)]);

    expect(truncatedValues).toBe(0);
    expect(checks[0].assertions![0].received).toBe(small);
  });

  it("collapses identical subjects to identical markers (the dedup)", () => {
    const doc = "D".repeat(50_000);
    const check: EvaluationItemResult = {
      id: "multi",
      pass: true,
      reasoning: "",
      assertions: [1, 2, 3].map((n) => ({
        id: `judge-${n}`,
        pass: true,
        reasoning: "",
        received: doc,
        evaluator_type: "llm" as const,
      })),
    };

    const { checks, truncatedValues } = compactChecksForSubmission([check]);
    const markers = checks[0].assertions!.map((a) => a.received);

    expect(truncatedValues).toBe(3);
    expect(markers[0]).toEqual(markers[1]);
    expect(markers[1]).toEqual(markers[2]);
    // Three 50 KB copies became three ~350-byte markers.
    expect(canonicalBytes(markers[0]).length).toBeLessThan(400);
  });

  it("truncates judge prompt and response segments over the segment limit", () => {
    const check: EvaluationItemResult = {
      id: "c",
      pass: true,
      reasoning: "",
      judge: {
        model: "m",
        prompt: { system: "s".repeat(JUDGE_SEGMENT_LIMIT + 1), user: "short" },
        response: "r".repeat(JUDGE_SEGMENT_LIMIT + 1),
      },
      assertions: [
        {
          id: "a",
          pass: true,
          reasoning: "",
          judge: { prompt: { user: "u".repeat(JUDGE_SEGMENT_LIMIT + 1) } },
        },
      ],
    };

    const { checks, truncatedSegments } = compactChecksForSubmission([check]);

    expect(truncatedSegments).toBe(3);
    const top = checks[0].judge!;
    expect((top.prompt!.system as Record<string, unknown>).kind).toBe("truncated");
    expect(top.prompt!.user).toBe("short");
    expect((top.response as Record<string, unknown>).kind).toBe("truncated");
    const nested = checks[0].assertions![0].judge!;
    expect((nested.prompt!.user as Record<string, unknown>).kind).toBe("truncated");
  });

  it("does not mutate the input checks", () => {
    const value = "y".repeat(10_000);
    const check = judgedCheck(value);

    compactChecksForSubmission([check]);

    expect(check.assertions![0].received).toBe(value);
  });

  it("is idempotent — compacting compacted checks is a no-op", () => {
    const value = "z".repeat(10_000);
    const once = compactChecksForSubmission([judgedCheck(value)]);

    const twice = compactChecksForSubmission(once.checks);

    expect(twice.truncatedValues).toBe(0);
    expect(twice.checks).toEqual(once.checks);
  });

  it("compacts the legacy top-level received shape too", () => {
    const check = {
      id: "legacy",
      pass: false,
      reasoning: "",
      received: "L".repeat(RECEIVED_VALUE_LIMIT + 100),
    } as unknown as EvaluationItemResult;

    const { checks, truncatedValues } = compactChecksForSubmission([check]);

    expect(truncatedValues).toBe(1);
    expect((checks[0] as unknown as Record<string, unknown>).received).toMatchObject({
      kind: "truncated",
    });
  });

  // Issue #249 reported 76/79-test tasks failing with HTTP 413 on versions
  // that predate compaction: every test judged the same large subject, so
  // the body carried N copies of it. These fixtures pin that the exact
  // reported shapes stay far under the 10 MiB result cap after compaction —
  // with tests, verdicts, and structure intact.
  it.each([76, 79])(
    "keeps a %i-test shared-subject result under the 10 MiB cap (issue #249 shape)",
    (count) => {
      const doc = "D".repeat(600 * 1024);
      const checks = Array.from({ length: count }, (_, i) => ({
        id: `criterion-${i}`,
        pass: true,
        reasoning: "ok",
        assertions: [
          {
            id: "judge",
            pass: true,
            reasoning: "ok",
            received: doc,
            evaluator_type: "llm" as const,
            judge: {
              model: "gpt-5",
              prompt: { system: "You are a judge.", user: doc.slice(0, 2000) },
              response: `PASS because reasons ${i}`,
            },
          },
        ],
      }));

      const rawBytes = canonicalBytes(checks).length;
      expect(rawBytes).toBeGreaterThan(40 * 1024 * 1024); // the reported blow-up shape
      const { checks: compacted, truncatedValues } = compactChecksForSubmission(checks);

      expect(truncatedValues).toBe(count);
      expect(compacted).toHaveLength(count);
      // Every test survives with a marker; none is dropped or truncated away.
      for (const check of compacted) {
        const received = check.assertions![0].received as Record<string, unknown>;
        expect(received.kind).toBe("truncated");
        expect(received.size_bytes).toBe(canonicalBytes(doc).length);
      }
      // Judge sub-threshold segments ride along untouched.
      const first = compacted[0].assertions![0].judge!;
      expect(first.prompt!.user).toBe(doc.slice(0, 2000));
      // The whole compacted result body fits under the backend's 10 MiB cap.
      expect(canonicalBytes(compacted).length).toBeLessThan(10_485_760);
    },
  );

  it("leaves sub-threshold judge segments inline even at high test counts", () => {
    // 79 tests × (system+response 15 KiB each + small unique received): every
    // field is below its limit, so compaction must not touch anything — and
    // the shape still fits under the cap uncompacted.
    const checks = Array.from({ length: 79 }, (_, i) => ({
      id: `criterion-${i}`,
      pass: true,
      reasoning: "ok",
      assertions: [
        {
          id: "judge",
          pass: true,
          reasoning: "ok",
          received: `sub-${i}-`.repeat(64),
          evaluator_type: "llm" as const,
          judge: {
            prompt: { system: "S".repeat(15_000), user: `U${i}-`.repeat(64) },
            response: "R".repeat(15_000),
          },
        },
      ],
    }));

    const { checks: compacted, truncatedValues, truncatedSegments } =
      compactChecksForSubmission(checks);

    expect(truncatedValues).toBe(0);
    expect(truncatedSegments).toBe(0);
    expect(compacted).toEqual(checks);
    expect(canonicalBytes(compacted).length).toBeLessThan(10_485_760);
  });
});
