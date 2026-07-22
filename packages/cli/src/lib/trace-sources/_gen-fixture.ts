// Generates the expected OTLP fixture from single-trace-v2.json using the
// real converter. Run with: node --experimental-strip-types \
//   packages/cli/src/lib/trace-sources/_gen-fixture.ts > \
//   backend/tests/fixtures/langfuse/single-trace-otlp.json
import { readFileSync } from "node:fs";
import { convertLangfuseTraceToOtlp } from "./langfuse-otlp.ts";

const raw = JSON.parse(
  readFileSync("backend/tests/fixtures/langfuse/single-trace-v2.json", "utf8"),
) as {
  pages: Array<{ data: ReadonlyArray<Record<string, unknown>> }>;
};

const observations = raw.pages.flatMap((p) => p.data);
const result = convertLangfuseTraceToOtlp({
  sourceHost: "https://cloud.langfuse.com",
  sourceTraceId: "8f38c27a2c4b4bafb87a78e3a3d62b90",
  observations: observations as never,
});

const out = {
  description:
    "Deterministic expected OTLP request produced by the Langfuse converter for backend/tests/fixtures/langfuse/single-trace-v2.json. Used by backend scene tests (SPEC-137 #2) and as a regression anchor when the converter changes.",
  sourceTraceId: "8f38c27a2c4b4bafb87a78e3a3d62b90",
  expectedTraceId: result.traceId,
  spanCount: result.spanCount,
  resourceSpans: result.otlpRequests[0]!.resourceSpans,
};
console.log(JSON.stringify(out, null, 2));
