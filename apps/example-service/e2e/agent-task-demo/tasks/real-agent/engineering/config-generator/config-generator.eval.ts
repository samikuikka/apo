/**
 * config-generator — demonstrates `t.assert` for computed/derived validation.
 *
 * Config generation has objective requirements (port=8080, replicas>=2) AND
 * computed constraints (monthly cost must be ≤ $1200). The `t.assert` escape
 * hatch lets you express predicates that require computation — here, checking
 * that the agent used `compute` to verify its cost arithmetic.
 *
 * This task also shows `satisfies` on a derived numeric value (tool-call
 * count), which is the simplest way to assert "the agent did enough work."
 *
 * Layers: trajectory (with t.assert) → fact table (config values) →
 * judges (requirement coverage, cost reasoning).
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

task("config-generator", {
  adapter: realAgentAdapter,
  description:
    "Generate a deployment configuration from requirements using templates, validation, and computation tools.",
  metadata: { category: "automation", difficulty: "hard" },
  maxTurns: 3,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// Objective config values from requirements.txt. These have one correct
// answer each — the agent must reproduce them in its generated config.
const EXPECTED_CONFIG = [
  { label: "service name", pattern: /payment-gateway/ },
  { label: "namespace", pattern: /production/ },
  { label: "container port", pattern: /8080/ },
  { label: "health path", pattern: /\/health/ },
  { label: "log level", pattern: /info/ },
  { label: "CPU request", pattern: /0\.5/ },
  { label: "CPU limit", pattern: /1\.0/ },
  { label: "memory request", pattern: /512/ },
  { label: "replica count ≥ 2", pattern: /[2-9]|1[0-9]/ },
  { label: "budget", pattern: /1200/ },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
// The agent must read both files AND use compute to verify arithmetic.
// `t.assert` demonstrates the escape hatch: a named predicate over the
// full trace, here checking that file-exploration tools were used.
check("explored-files-and-computed", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /template\.yaml/ } });
  t.calledTool("read_file", { input: { path: /requirements\.txt/ } });
  t.calledTool("compute");
  t.assert("used file-exploration tools", (flow) =>
    flow.toolCalls.some((c) => c.name === "read_file" || c.name === "list_files"),
  );
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective facts ─────────────────────────────────────────────
// Every required config value must appear in the output. This is the
// anti-omission anchor — a config that misses the port, health path, or
// budget constraint fails here, regardless of how good the prose looks.
check("config-has-all-required-values", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, EXPECTED_CONFIG);

  t.check(
    deliverables.stats.total_tool_calls,
    satisfies((n: number) => n >= 3, "used at least 3 tools (read, compute, etc.)"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: requirement coverage. Did the agent address ALL requirement
// categories — not just the config values, but the HA constraint (tolerate
// 1 failure), the latency target (<200ms), and the headroom buffer (20%)?
// The fact table checks individual values; this judge checks holistic
// requirement coverage.
check("addressed-all-requirement-categories", async (t, { deliverables }) => {
  await t.judge(
    [deliverables.result.findings, deliverables.result.summary],
    "PASS if the config addresses ALL requirement categories from requirements.txt: service config (name, namespace, port, health, log level), resource limits (CPU/memory requests and limits), high availability (≥2 replicas, tolerating 1 failure), budget (≤$1200/month with cost arithmetic shown), AND the latency/headroom notes (P99 <200ms, 20% buffer). FAIL if any requirement category is missing or the output doesn't reference the requirements file.",
  );
});

// Judge B: cost reasoning. Did the agent actually COMPUTE the monthly cost
// and show the arithmetic, or just parrot the budget number? A good config
// generator proves the deployment fits the budget: replicas × (CPU cost +
// memory cost) × 730 hours ≤ $1200.
check("showed-cost-arithmetic", async (t, { deliverables }) => {
  await t.judge(
    [deliverables.result.findings, deliverables.result.summary],
    "PASS if the output shows cost computation: monthly cost = replicas × (CPU cores × $0.05 + memory GB × $0.01) × 730 hours, and verifies it stays within the $1200 budget. FAIL if the budget number is mentioned without showing the arithmetic, or if the cost math is wrong.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("files-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("template.yaml"));
  t.check(paths, includes("requirements.txt"));
});
