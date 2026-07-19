/**
 * api-testing — demonstrates `matches(schema)` and `t.assert` coverage ratio.
 *
 * This task validates API responses against a JSON schema. Two framework
 * features shine here:
 *
 *   1. `matches(zodSchema)` — schema-validate a value inside a check. The
 *      deliverables are already Zod-validated by the adapter, but you can
 *      re-validate fragments or derived values with stricter schemas.
 *
 *   2. `t.assert(label, predicate)` — the escape hatch for predicates over
 *      the full trace. Here we compute a coverage ratio: of N planted
 *      violations, how many did the agent catch? We assert ≥ threshold.
 *      This gives partial-credit signal: 7/8 is better than 2/8, but both
 *      fail the binary check — the assertion breakdown shows exactly which
 *      ones were missed.
 *
 * Layers: trajectory → fact table (violation signals) → coverage assert →
 * judges (completeness, specificity).
 */
import { z } from "zod";
import {
  task,
  test,
  includes,
  satisfies,
  matches,
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

task("api-testing", {
  adapter: realAgentAdapter,
  description:
    "Verify API response data against expected schemas and contracts. Check field types, required fields, and validate data consistency.",
  metadata: { category: "testing", difficulty: "medium" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// The 8 planted violations in api-responses.json. Each has a signal pattern
// the agent's findings should contain if it caught that violation.
const EXPECTED_VIOLATIONS = [
  { label: "negative user id (-3)", pattern: /-3|negative.*id|id.*negative/ },
  { label: "empty user name (id=4)", pattern: /empty|"".*name|name.*""/ },
  { label: "malformed email (bob@example)", pattern: /bob@example|malformed.*email|email.*malformed/ },
  { label: "invalid role (superadmin)", pattern: /superadmin|invalid.*role|role.*enum/ },
  { label: "bad date-time (invalid-date)", pattern: /invalid-date|bad.*date|date.*format/ },
  { label: "negative order total (-15)", pattern: /-15|negative.*total|total.*negative/ },
  { label: "empty items array (order 102)", pattern: /empty.*items|items.*\[\]|minItems/ },
  { label: "dangling user_id (99)", pattern: /99|dangling|reference.*user|user_id.*exist/ },
] as const;

// A schema fragment for a well-formed finding string: it should mention
// either a record id or a field name. This demonstrates `matches()` —
// schema-validating a derived value inside a check.
const findingSchema = z.string().and(
  z.string().regex(/\b(id|user|order|name|email|role|total|items|status|created_at)\b/i, {
    message: "finding must reference a specific field or record",
  }),
);

// ── Layer 1: trajectory ──────────────────────────────────────────────────
check("read-responses-and-schema", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /expected-schema\.json/ } });
  t.calledTool("read_file", { input: { path: /api-responses\.json/ } });
  t.calledTool("check_rules");
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective signals ───────────────────────────────────────────
// Each planted violation should appear in the findings. This is the
// anti-fabrication anchor — the agent can't pass by inventing generic
// "schema mismatch" findings; it has to reference the actual violations.
check("caught-planted-violations", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, EXPECTED_VIOLATIONS);

  // Demonstrate `matches()`: validate that at least the first finding
  // is structured enough to reference a field or record id. This is a
  // lighter-weight check than a full judge for "is this finding specific?"
  if (deliverables.result.findings.length > 0) {
    t.check(
      deliverables.result.findings[0],
      matches(findingSchema),
      "first finding references a field or record",
    );
  }

  t.check(
    deliverables.stats.total_tool_calls,
    satisfies((n: number) => n >= 2, "used at least 2 tools"),
  );
});

// ── Layer 2b: coverage ratio via t.assert ────────────────────────────────
// `t.assert` is the escape hatch for predicates over the full trace. Here
// we compute how many of the 8 planted violations the agent caught (by
// checking each signal pattern against the findings) and assert ≥ 6.
// The assertion breakdown shows exactly which violations were missed —
// partial-credit signal in a binary check.
check("caught-majority-of-violations", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  t.assert(
    `caught at least 6 of 8 planted violations`,
    () => {
      const caught = EXPECTED_VIOLATIONS.filter((v) => v.pattern.test(findingsText)).length;
      return caught >= 6;
    },
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: completeness. Did the agent catch all 8 violations, or miss some?
// The fact table already checks each individually; this judge assesses
// whether the OVERALL analysis is comprehensive and doesn't fabricate
// violations that don't exist.
check("analysis-is-comprehensive", async (t, { deliverables }) => {
  await t.judge(
    [deliverables.result.findings, deliverables.result.summary],
    "PASS if the findings catch all 8 planted schema violations without fabricating any that don't exist: user id=-3 (negative), user id=4 name='' (empty), bob@example (malformed email), role='superadmin' (invalid enum), user id=5 created_at='invalid-date' (bad date-time), order 102 total=-15 (negative), order 102 items=[] (minItems), order 102 user_id=99 (dangling FK), order 103 status='unknown' (invalid enum). FAIL if violations are missed or fabricated.",
  );
});

// Judge B: specificity. Are the findings field-level (referencing the record
// id AND the field AND the constraint), or generic ("response doesn't match
// schema")?
check("findings-are-field-specific", async (t, { deliverables }) => {
  await t.judge(
    [deliverables.result.findings, deliverables.result.summary],
    "PASS if each finding identifies the specific record (by id), the specific field, AND the constraint violated — e.g. 'user id=-3: id field violates minimum=1 constraint'. FAIL if findings are generic like 'response does not match schema' or 'validation failed' without naming the record and field.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("files-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("api-responses.json"));
  t.check(paths, includes("expected-schema.json"));
});
