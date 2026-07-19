/**
 * data-extraction — Claude Agent SDK, native-OTel path.
 *
 * This task mirrors the real-agent document-qa pattern (trajectory → objective
 * facts → judged quality) so the Claude adapter is held to the same bar as the
 * in-process adapters, not a weaker one. The facts come from invoice.txt; the
 * judges check that the agent actually read the file (grounding) and didn't
 * stop at one or two values (completeness).
 *
 * The adapter is thin and the Claude Agent SDK uses its own built-in tools
 * (Read/Grep/Bash), so trajectory assertions target those names, not apo's
 * in-process tools. On a backend run the SDK's native OTel flows to the apo
 * backend and the eval reads it back via Track C; offline, the adapter mirrors
 * observed tool calls into the local projection (same pattern as
 * createApoAnthropic).
 */
import {
  task,
  test,
  includes,
  satisfies,
  filePaths,
} from "@apo/sdk/agent-task";
import { claudeAdapter } from "../../../claude-adapter.ts";
import {
  MAX_DURATION_MS,
  MAX_TOOL_CALLS,
  assertFacts,
} from "../../real-agent/checks-helpers.ts";

/** What the claude adapter delivers (defined in claude-adapter.ts). */
type ClaudeDeliverables = {
  result: { summary: string };
  stats: { turn_count: number; num_turns: number };
};

task("data-extraction", {
  adapter: claudeAdapter,
  description: "Extract structured data from an invoice via the Claude Agent SDK.",
  metadata: { category: "data-processing", difficulty: "easy", sdk: "claude-agent-sdk" },
  maxTurns: 2,
  deliverables: ["result", "stats"],
});

const check = test<ClaudeDeliverables>;

// Objective facts from invoice.txt. Exact-match regex for the values that
// have one correct answer; `similarity` is not needed here because the
// numbers/names are unambiguous.
const EXPECTED_FACTS = [
  { label: "invoice number", pattern: /INV-2024-00847/ },
  { label: "invoice total", pattern: /9[,]?376\.60/ },
  { label: "subtotal", pattern: /8[,]?661\.99/ },
  { label: "tax amount", pattern: /714\.61/ },
  { label: "due date", pattern: /2024-02-15/ },
  { label: "seller name", pattern: /Acme Cloud Solutions/i },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
// The agent must have read the file (not answered from imagination) and not
// thrashed. `Read` is the Claude Agent SDK's built-in read tool.
check("read-invoice-and-no-thrash", (t) => {
  t.calledTool("Read");
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective facts ─────────────────────────────────────────────
// The deterministic anchor: did the agent extract the actual numbers from the
// invoice, not plausible-sounding ones? These catch hallucination far better
// than a judge, which is why they run first.
check("extracts-all-key-facts", (t, { deliverables }) => {
  const text = deliverables.result.summary;
  assertFacts(t, text, EXPECTED_FACTS);

  t.check(
    deliverables.stats.num_turns,
    satisfies((n: number) => n >= 1 && n <= 8, "ran a sane number of turns"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: grounding. Anti-hallucination — the numbers above could in principle
// be matched by an agent that guessed, so confirm the response reads like it
// came from THIS invoice (references the items, the seller, the structure).
check("findings-grounded-in-invoice", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.summary,
    "PASS if the response references specifics that only appear in invoice.txt — e.g. the line items (Cloud Hosting, API Gateway, Managed Database, SSL Certificate, Priority Support, Data Migration), the seller (Acme Cloud Solutions), or the payment terms (Net 30). FAIL if the answer could have been written without reading the file (generic invoice language, or numbers with no source context).",
  );
});

// Judge B: completeness. Did the agent extract a useful set of structured data,
// or stop after the total? A good extraction covers the money fields AND the
// parties AND the dates.
check("extraction-is-complete", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.summary,
    "PASS if the response covers all of: the monetary fields (subtotal, tax, total), at least the seller and buyer, and at least two dates. FAIL if any of those three groups is missing entirely, or if only the total is reported.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("invoice-file-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("invoice.txt"));
});
