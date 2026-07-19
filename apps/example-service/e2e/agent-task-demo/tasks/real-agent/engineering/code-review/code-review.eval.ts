/**
 * code-review — demonstrates multi-turn conversation via `turn()`.
 *
 * Most tasks are single-turn: the agent receives instructions, does work,
 * returns. But real code review is a conversation — you ask, the reviewer
 * responds, you push back ("also check edge cases"), the reviewer digs
 * deeper. The `turn()` function lets you script that conversation:
 *
 *   turn 0 → send instructions.md (the initial review request)
 *   turn 1 → send a follow-up ("also check edge cases in error handling")
 *   turn 2 → return null to end the conversation
 *
 * This task also demonstrates `t.toolOrder` (assert tools appear as a
 * subsequence, not exact order) and `calledTool` with both `input` field-
 * matching and `count` constraints.
 *
 * Layers: trajectory (multi-file + ordered) → fact table (known code issues)
 * → judges (grounding, specificity, edge-case follow-up).
 */
import {
  task,
  test,
  includes,
  satisfies,
  filePaths,
  turn,
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

task("code-review", {
  adapter: realAgentAdapter,
  description:
    "Review source code for bugs, style issues, and improvements. Agent uses read_file, search_content, and check_rules tools.",
  metadata: { category: "code-quality", difficulty: "medium" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// ── Multi-turn conversation ──────────────────────────────────────────────
// `turn()` overrides the adapter's default single-turn behavior. Each call
// returns the next user message; returning null ends the conversation.
// This simulates a real review where the reviewer gets a follow-up question.
turn(async ({ files, transcript }) => {
  if (transcript.length === 0) {
    return await files.read("instructions.md");
  }
  if (transcript.length === 1) {
    return "Good start. Can you also check for edge cases in the error handling and input validation?";
  }
  return null;
});

// The known issues in source.py. Each is a concrete, verifiable bug that a
// competent review must catch. These are deterministic anchors — the agent
// either identifies `calculate_discount`'s silent clamping or it doesn't.
// The function name must appear in the findings.
const EXPECTED_ISSUES = [
  { label: "process_order negative input", pattern: /process_order/ },
  { label: "calculate_discount silent clamp", pattern: /calculate_discount/ },
  { label: "format_receipt KeyError risk", pattern: /format_receipt/ },
  { label: "load_config error swallowing", pattern: /load_config/ },
  { label: "add_item unvalidated merge", pattern: /add_item/ },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
// The agent must read BOTH files (not just one), search for patterns, and
// do so in a sensible order. `toolOrder` asserts a subsequence — the agent
// can interleave other calls, but read_file must come before search_content.
check("reviewed-methodically", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /source\.py/ } });
  t.calledTool("read_file", { input: { path: /tests\.py/ } });
  t.toolOrder(["read_file", "search_content"]);
  t.calledTool("search_content");
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective facts ─────────────────────────────────────────────
// The agent must reference each of the 5 known-issue functions by name in
// its findings. This is the anti-shallowness anchor — a review that says
// "the code has some issues with error handling" without naming functions
// fails here. Also confirms the multi-turn conversation actually happened.
check("identified-known-issues", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, EXPECTED_ISSUES);

  // The follow-up turn should have added depth — at least 2 findings means
  // the agent did real work, not just a one-liner.
  t.check(
    deliverables.result.findings.length,
    satisfies((n: number) => n >= 2, "at least 2 findings"),
  );
  // Confirm the multi-turn conversation actually happened.
  t.check(
    deliverables.stats.turn_count,
    satisfies((n: number) => n >= 1, "at least 1 turn"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: grounding. Did the agent actually read the code, or write generic
// review boilerplate? The trajectory check proves it called read_file, but
// this judge confirms the findings reference content that could ONLY come
// from reading source.py — specific variable names, logic patterns, line
// numbers.
check("findings-grounded-in-source", async (t, { deliverables }) => {
  await t.judge(
    [deliverables.tool_log.details, deliverables.result.findings],
    "PASS if the findings reference specific content from source.py — variable names, function logic, line numbers, concrete code patterns — that could only come from actually reading the file. FAIL if findings are generic code-review boilerplate like 'improve error handling' or 'add type hints' that could be written without reading the code.",
  );
});

// Judge B: specificity & actionability. Are the findings specific enough to
// act on? "calculate_discount silently clamps discount_percent to max_discount
// instead of raising" is actionable. "Discount logic has issues" is not.
check("findings-are-specific-and-actionable", async (t, { deliverables }) => {
  await t.judge(
    [deliverables.result.findings, deliverables.result.summary],
    "PASS if each finding names the function, describes the specific bug or risk, and suggests a concrete fix area (e.g. 'process_order does not validate negative quantity/price — add a guard clause'). FAIL if findings are vague like 'check for bugs' or 'improve readability' without function-level specificity.",
  );
});

// Judge C: edge-case follow-up. The second turn asked specifically about edge
// cases in error handling and input validation. Did the agent address that
// follow-up, or ignore it? This tests multi-turn responsiveness.
check("addressed-edge-case-followup", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the findings specifically address edge cases in error handling and input validation — e.g. negative values in process_order, missing dict keys in format_receipt, invalid JSON in load_config, or unvalidated inputs in add_item. FAIL if edge cases are not addressed or the response ignores the follow-up question about error handling.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("source-files-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("source.py"));
  t.check(paths, includes("tests.py"));
});
