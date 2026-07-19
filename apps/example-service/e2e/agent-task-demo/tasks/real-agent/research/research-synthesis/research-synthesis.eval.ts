/**
 * research-synthesis — demonstrates `equals()` on a sources-referenced set
 * and cross-source synthesis judging.
 *
 * Synthesis is fundamentally about RELATIONSHIPS between sources: where do
 * they agree, where do they disagree, what's the consensus? A shallow
 * summary lists each source's findings independently; a good synthesis
 * cross-references them. The judges here specifically test for that
 * cross-referencing behavior.
 *
 * The `equals()` matcher checks that the agent referenced ALL THREE sources
 * (not just one or two) — extracted as a set and compared to the expected
 * set.
 *
 * Layers: trajectory (read all 3 sources) → fact table (disagreement
 * numbers) + equals (sources set) → judges (disagreement detection,
 * consensus synthesis).
 */
import {
  task,
  test,
  includes,
  satisfies,
  equals,
  filePaths,
} from "@apo/sdk/agent-task";
import { realAgentAdapter } from "../../../../real-agent-adapter.ts";
import type { RealAgentDeliverables } from "../../../../real-agent-adapter.ts";
import {
  MAX_TURNS,
  MAX_DURATION_MS,
  MAX_TOOL_CALLS,
  DESTRUCTIVE_TOOLS,
  assertFacts,
  joinFindings,
} from "../../checks-helpers.ts";

task("research-synthesis", {
  adapter: realAgentAdapter,
  description:
    "Synthesize information from multiple research sources, extract key findings, and compare perspectives.",
  metadata: { category: "research", difficulty: "medium" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// The key cross-source disagreements. These are objective facts — Source B
// explicitly disputes Source A's 47% claim, and Source C explicitly reports
// A's accuracy gains didn't translate to production. The agent must surface
// both disagreements, naming the sources.
const EXPECTED_DISAGREEMENTS = [
  { label: "Source A's 47% claim", pattern: /47/ },
  { label: "Source B's 28-35% counter", pattern: /28.?35/ },
  { label: "Source A's 23-41% gains", pattern: /23.?41/ },
  { label: "Source C's 8-15% production", pattern: /8.?15/ },
  { label: "Source A reference", pattern: /[Aa]\b|Smith/ },
  { label: "Source B reference", pattern: /[Bb]\b|Chen/ },
  { label: "Source C reference", pattern: /[Cc]\b|Patel/ },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
// `count: 3` asserts the agent read exactly 3 files — all three sources.
// A synthesis that only reads 2 of 3 sources is fundamentally incomplete.
check("read-all-three-sources", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { count: 3 });
  t.calledTool("read_file", { input: { path: /source-a\.md/ } });
  t.calledTool("read_file", { input: { path: /source-b\.md/ } });
  t.calledTool("read_file", { input: { path: /source-c\.md/ } });
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective facts ─────────────────────────────────────────────
check("captured-cross-source-disagreements", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, EXPECTED_DISAGREEMENTS);

  // Demonstrate `equals()`: the set of source labels mentioned must be
  // exactly {A, B, C} — the agent must reference all three, not just one.
  // We extract which source letters appear and compare to the expected set.
  const sourcePattern = /\b([A-C])\b/g;
  const mentioned = new Set(
    [...findingsText.matchAll(sourcePattern)].map((m) => m[1]),
  );
  t.check(
    [...mentioned].sort(),
    equals(["A", "B", "C"]),
    "referenced all three sources (A, B, and C)",
  );

  t.check(
    deliverables.result.findings.length,
    satisfies((n: number) => n >= 2, "at least 2 findings"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: disagreement detection. Did the agent explicitly frame the
// conflicts BETWEEN sources (B disputes A; C reports A's gains don't hold
// in production), or just list each source's numbers independently?
// Cross-referencing is the defining skill of synthesis.
check("framed-cross-source-disagreements", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the synthesis explicitly identifies the disagreements BETWEEN sources: Source B disputes Source A's 47% cost-saving claim (asserting 28-35% once infrastructure costs are counted), AND Source C reports that Source A's 23-41% academic accuracy gains translated to only 8-15% in production. The disagreements must be framed as conflicts between named sources, not just listed as separate statistics. FAIL if disagreements are omitted or described without naming which source disputes which.",
  );
});

// Judge B: consensus synthesis. Beyond disagreements, did the agent identify
// where sources AGREE and what the shared recommendations are? A good
// synthesis balances both — conflicts AND consensus.
check("identified-shared-consensus", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the synthesis captures the consensus/recommendations shared across sources — automated evaluation (LLM-as-judge) ROI, weighted prompt-engineering budget allocation, treating prompts as version-controlled code, and production drift monitoring — AND attributes them as shared/consensus positions rather than a single source's recommendation. FAIL if only one source's recommendations appear, or if consensus is not distinguished from individual findings.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("sources-attached", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("source-a.md"));
  t.check(paths, includes("source-b.md"));
  t.check(paths, includes("source-c.md"));
});
