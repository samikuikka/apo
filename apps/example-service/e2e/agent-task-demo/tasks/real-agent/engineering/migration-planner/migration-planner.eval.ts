/**
 * migration-planner — demonstrates `equals()` on derived sets and `count`.
 *
 * A migration plan has structural requirements that are set-based, not
 * scalar: the plan must create exactly the set of new tables {categories,
 * order_items}, not a subset or superset. The `equals()` matcher is for
 * deep structural equality — here we extract the set of new-table names
 * the agent mentioned and compare it to the expected set.
 *
 * This task also demonstrates `calledTool("read_file", { count: 2 })` —
 * asserting the agent read exactly 2 files (both schemas), not just one.
 *
 * Layers: trajectory (count-based read) → fact table (schema deltas) +
 * equals (new-table set) → judges (SQL ordering, FK dependency awareness).
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

task("migration-planner", {
  adapter: realAgentAdapter,
  description:
    "Plan a database migration by analyzing the current schema, proposed changes, and generating a step-by-step migration plan.",
  metadata: { category: "planning", difficulty: "hard" },
  maxTurns: 3,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// Objective schema deltas between current-schema.sql and target-schema.sql.
const EXPECTED_DELTAS = [
  { label: "new table: categories", pattern: /categories/ },
  { label: "new table: order_items", pattern: /order_items/ },
  { label: "users.email UNIQUE", pattern: /email.*UNIQUE|UNIQUE.*email/ },
  { label: "users.email VARCHAR(255)", pattern: /255/ },
  { label: "new column: display_name", pattern: /display_name/ },
  { label: "new column: avatar_url", pattern: /avatar_url/ },
  { label: "new column: is_active", pattern: /is_active/ },
  { label: "orders.user_id NOT NULL", pattern: /user_id.*NOT NULL|NOT NULL.*user_id/ },
  { label: "orders.total DECIMAL(12,2)", pattern: /12,2/ },
  { label: "products.category_id FK", pattern: /category_id/ },
  { label: "new index: idx_orders_status", pattern: /idx_orders_status/ },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
// `count: 2` asserts exactly 2 read_file calls — the agent must read BOTH
// schemas, not just one. This is stricter than calling calledTool twice
// (which would allow 3+ reads).
check("read-both-schemas", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { count: 2 });
  t.calledTool("read_file", { input: { path: /current-schema\.sql/ } });
  t.calledTool("read_file", { input: { path: /target-schema\.sql/ } });
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective facts ─────────────────────────────────────────────
check("identified-schema-deltas", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, EXPECTED_DELTAS);

  // Demonstrate `equals()`: extract the set of new-table names the agent
  // mentioned and compare to the expected set. The agent must identify
  // EXACTLY {categories, order_items} — not one, not three.
  const mentionedTables = new Set(
    ["categories", "order_items"].filter((name) => findingsText.includes(name)),
  );
  t.check(
    [...mentionedTables].sort(),
    equals(["categories", "order_items"]),
    "identified both new tables (and only those)",
  );

  t.check(
    deliverables.result.findings.length,
    satisfies((n: number) => n >= 2, "at least 2 migration steps"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: SQL ordering. Did the agent produce ordered, executable SQL
// (CREATE TABLE before ALTER TABLE, tables before FKs that reference them)?
// This is a structural reasoning check — the fact table proves the deltas
// were identified; this judge checks the plan is executable in order.
check("plan-has-ordered-executable-sql", async (t, { deliverables }) => {
  await t.judge(
    [deliverables.result.findings, deliverables.result.summary],
    "PASS if the migration plan proposes ordered, executable SQL statements (CREATE TABLE, ALTER TABLE, CREATE INDEX) that respect dependency order: categories must be created before products.category_id FK; orders must exist before order_items.order_id FK. FAIL if the plan is generic prose without actual SQL, or if FK dependencies are ignored (e.g. order_items created before orders).",
  );
});

// Judge B: rollback awareness. A production-grade migration plan includes
// rollback steps. Did the agent think about reversibility, or only forward
// migration? This tests operational maturity beyond pure schema diffing.
check("plan-includes-risk-and-rollback", async (t, { deliverables }) => {
  await t.judge(
    [deliverables.result.findings, deliverables.result.summary],
    "PASS if the migration plan includes risk assessment for at least some steps (e.g. 'NOT NULL on existing rows requires backfill or default') AND rollback guidance (e.g. 'to rollback: DROP TABLE order_items, DROP TABLE categories, ALTER TABLE users ALTER COLUMN email DROP NOT NULL'). FAIL if the plan is forward-only with no risk assessment or rollback consideration.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("schema-files-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("current-schema.sql"));
  t.check(paths, includes("target-schema.sql"));
});
