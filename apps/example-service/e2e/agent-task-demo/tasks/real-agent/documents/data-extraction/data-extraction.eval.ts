/**
 * data-extraction — the "start here" task.
 *
 * Read this file first if you're learning how to write agent tests with apo.
 * It shows the canonical layered suite every task should have:
 *
 *   1. Trajectory check (deterministic) — did the agent use the right tools?
 *   2. Fact-table check (deterministic) — did it extract the objective facts?
 *   3. Judge checks (LLM-as-judge) — is the reasoning grounded and complete?
 *
 * The principle: each layer tests what it's good at. Deterministic checks
 * pin down objective facts and process honesty so judges can't be gamed by
 * plausible-sounding hallucinations. Judges assess the subjective quality —
 * grounding, completeness — that code can't. A test with only one layer is
 * either too weak (deterministic-only passes shallow answers) or too flaky
 * (judge-only is gameable). Layer both.
 */
import {
  task,
  test,
  includes,
  satisfies,
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

task("data-extraction", {
  adapter: realAgentAdapter,
  description:
    "Extract structured data from an invoice document using entity extraction and validation tools.",
  metadata: { category: "data-processing", difficulty: "easy" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// The verifiable facts from invoice.txt. There is one correct answer for each
// of these — the invoice either says $9,376.60 or it doesn't. These are
// deterministic anchors: fast, objective, and immune to judge bias. An agent
// that hallucinates a plausible-sounding total still fails here.
const EXPECTED_FACTS = [
  { label: "invoice number", pattern: /INV-2024-00847/ },
  { label: "invoice date", pattern: /2024-01-15/ },
  { label: "due date", pattern: /2024-02-15/ },
  { label: "subtotal", pattern: /8,661\.99/ },
  { label: "tax amount", pattern: /714\.61/ },
  { label: "total", pattern: /9,376\.60/ },
  { label: "seller name", pattern: /Acme Cloud Solutions/ },
  { label: "buyer name", pattern: /TechStart Labs/ },
  { label: "seller email", pattern: /billing@acmecloud\.io/ },
  { label: "payment terms", pattern: /Net 30/ },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
// Did the agent explore the workspace and use the extraction tools, or did
// it answer from memory? A plausible answer written without reading the file
// would pass a judge but fail this — that's why trajectory comes first.
check("used-extraction-workflow", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /invoice\.txt/ } });
  t.calledTool("extract_entities");
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective facts ─────────────────────────────────────────────
// Every fact in EXPECTED_FACTS must appear in the findings. This is the
// anti-hallucination anchor — the agent can't pass by sounding right; it
// has to actually contain the verifiable values from the invoice.
check("extracted-all-key-fields", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, EXPECTED_FACTS);

  // The agent should also have done real work — not just one tool call.
  t.check(
    deliverables.stats.total_tool_calls,
    satisfies((n: number) => n >= 2, "used at least 2 tools"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────
// Now the subjective dimensions code can't assess. Each judge grades ONE
// dimension so the signal stays clean — not one overloaded mega-judge.

// Judge A: grounding. Are the extracted values actually from THIS invoice,
// or could they have been fabricated? This catches the agent that produces
// a correct-looking invoice summary without truly reading the file.
check("findings-grounded-in-invoice", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if every number, date, name, and email in the findings can be traced to the invoice document content — no fabricated or generic placeholder values. FAIL if any value appears invented, rounded imprecisely, or copied from a different document.",
  );
});

// Judge B: completeness. Did the agent get the HARD fields too — the early-pay
// discount, the contact people, the line items — or just the obvious ones?
// A shallow extraction that grabs only the total and dates fails this.
check("extraction-is-thorough", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the findings go beyond the obvious header fields and also capture secondary details: the 2% early-pay discount ($7,188.87), the contact person (Sarah Mitchell), the account manager (James Rodriguez), and at least some of the six line items. FAIL if only the invoice number, dates, and total are present without these secondary details.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
// Confirms the task ships the file the trajectory check expects to be read.
check("invoice-file-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("invoice.txt"));
});
