/**
 * Benchmarks for the OTel span translation hot path.
 *
 * `translateOtelSpan` runs once per exported span inside `ApoSpanProcessor`,
 * so its cost is paid by every traced agent turn — it is the SDK's tightest
 * per-span loop. Each benchmark walks a whole 300-span batch rather than a
 * single span, so the measured region is large enough to be stable under
 * CodSpeed's instrumentation.
 */

import { bench, describe } from "vitest";

import {
  extractTextFromAttrs,
  safeParse,
  translateOtelSpan,
} from "../src/agent-task/integrations/otel-translate.ts";
import { extractTokenCounts } from "../src/agent-task/integrations/token-usage.ts";
import { buildOtelSpans } from "./fixtures.ts";

const SPAN_BATCH = buildOtelSpans(300);
const ATTRIBUTE_BATCH = SPAN_BATCH.map((s) => s.data.attributes);
const JSON_ATTRIBUTE_BATCH = ATTRIBUTE_BATCH.map(
  (attrs) =>
    attrs["ai.toolCall.args"] ??
    attrs["gen_ai.tool.call.arguments"] ??
    attrs["ai.prompt.messages"] ??
    "{}",
);

describe("otel-translate", () => {
  bench("translateOtelSpan over a 300-span mixed batch", () => {
    for (const span of SPAN_BATCH) {
      translateOtelSpan(span.name, span.data);
    }
  });

  bench("extractTextFromAttrs over a 300-span batch", () => {
    for (const attrs of ATTRIBUTE_BATCH) {
      extractTextFromAttrs(attrs);
    }
  });

  bench("extractTokenCounts over a 300-span batch", () => {
    for (const attrs of ATTRIBUTE_BATCH) {
      extractTokenCounts(attrs);
    }
  });

  bench("safeParse over 300 JSON attribute strings", () => {
    for (const raw of JSON_ATTRIBUTE_BATCH) {
      safeParse(raw);
    }
  });
});
