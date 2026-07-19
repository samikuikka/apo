/**
 * document-qa — demonstrates the `similarity` matcher for prose answers.
 *
 * Some agent outputs are prose, not structured data. When the expected answer
 * is a specific phrase ("JWT Bearer tokens") but the agent might paraphrase
 * ("JSON Web Token authentication"), exact regex matching is too brittle and
 * a judge is overkill. `similarity(expected, threshold)` fills that gap:
 * normalized Levenshtein similarity, so paraphrases that are close enough
 * still pass. Use it for short factual phrases where wording may vary.
 *
 * Layers: trajectory → fact table (regex + similarity) → judges (grounding,
 * completeness).
 */
import {
  task,
  test,
  includes,
  satisfies,
  similarity,
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

task("document-qa", {
  adapter: realAgentAdapter,
  description:
    "Read a technical specification document and answer specific questions by searching and extracting relevant information.",
  metadata: { category: "comprehension", difficulty: "easy" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// Objective facts from spec.md. Most are exact-match regex (version numbers,
// product names) — these have one correct answer. But "JWT Bearer tokens"
// and "OAuth 2.0 client credentials" are phrases the agent may paraphrase,
// so we also use `similarity` below for those.
const EXPECTED_FACTS = [
  { label: "API version", pattern: /2\.4/ },
  { label: "database", pattern: /PostgreSQL 16/ },
  { label: "cache", pattern: /Redis 7\.2/ },
  { label: "endpoint count", pattern: /11/ },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
check("read-spec-and-searched", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /spec\.md/ } });
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective facts ─────────────────────────────────────────────
// Regex for the exact-match facts, plus `similarity` for the prose answers
// where the agent may paraphrase. Together they cover all five questions
// deterministically — the judge then assesses whether the answers are
// actually grounded in the spec, not just keyword-matched.
check("answers-all-five-questions", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);

  // Exact matches: version, database, cache, endpoint count.
  assertFacts(t, findingsText, EXPECTED_FACTS);

  // Similarity matches: the auth method and flow are phrases that may be
  // worded differently. 0.6 threshold = "close enough" — catches "JSON Web
  // Token" or "JWT-based bearer auth" without requiring exact wording.
  t.check(findingsText, similarity("JWT Bearer tokens", 0.6), "auth method");
  t.check(
    findingsText,
    similarity("OAuth 2.0 client credentials", 0.6),
    "auth flow",
  );

  t.check(
    deliverables.stats.total_tool_calls,
    satisfies((n: number) => n >= 2, "used at least 2 tools"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: grounding. Are the answers actually from the spec, or generic API
// knowledge? This is the anti-hallucination check — a model could answer
// "PostgreSQL" from training data without reading spec.md.
check("answers-grounded-in-spec", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the answers cite or reference specific sections, tables, or endpoint listings of the spec (e.g. 'Section 2 Architecture', 'Section 3 Authentication', 'Section 5 Endpoints'). FAIL if the answers are generic API knowledge that could have been written without reading spec.md.",
  );
});

// Judge B: completeness. Did the agent answer all five questions with enough
// context to be useful, or just list bare values? A good QA agent explains
// WHERE in the document each answer comes from.
check("answers-are-complete-and-useful", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if each of the five answers (API version, auth method, endpoint count, database, cache) is present AND accompanied by enough context to be useful — e.g. not just '2.4' but 'API version 2.4 per the document header'. FAIL if answers are bare values without context, or if any question is missing entirely.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("spec-file-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("spec.md"));
});
