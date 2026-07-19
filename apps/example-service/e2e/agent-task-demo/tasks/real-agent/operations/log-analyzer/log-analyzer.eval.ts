/**
 * log-analyzer — demonstrates anomaly-detection judging with the new
 * access.log fixture.
 *
 * Log analysis is a pattern-recognition task: the agent must identify
 * traffic patterns, anomalies, and attacks from raw log lines. The
 * deterministic layer catches whether the agent found the specific planted
 * signals (scanner IP, 5xx cluster, 429 rate-limit); the judges assess
 * whether the analysis is specific, contextualized, and actionable.
 *
 * This task's fixture (access.log) was missing — it's now created with
 * planted anomalies that the fact table and judges reference.
 *
 * Layers: trajectory → fact table (anomaly signals) → judges (scanner
 * detection, error-cluster detection, analysis specificity).
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

task("log-analyzer", {
  adapter: realAgentAdapter,
  description:
    "Analyze server access logs to identify traffic patterns, anomalies, potential attacks, and performance bottlenecks.",
  metadata: { category: "observability", difficulty: "medium" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// Objective signals from access.log. These are the planted anomalies —
// each has a verifiable presence in the log that the agent should detect.
const EXPECTED_SIGNALS = [
  { label: "scanner IP", pattern: /45\.33\.32\.156/ },
  { label: "scanner path /admin", pattern: /\/admin/ },
  { label: "scanner path /.env", pattern: /\/\.env/ },
  { label: "scanner path /wp-admin", pattern: /\/wp-admin/ },
  { label: "scanner user-agent", pattern: /python-requests/ },
  { label: "5xx errors", pattern: /5\d\d|500|503/ },
  { label: "error endpoint /api/v2/orders", pattern: /\/api\/v2\/orders/ },
  { label: "error source IP", pattern: /10\.0\.0\.51/ },
  { label: "429 rate-limit", pattern: /429/ },
] as const;

// ── Layer 1: trajectory ──────────────────────────────────────────────────
check("analyzed-access-log", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /access\.log/ } });
  t.calledTool("search_content");
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2: objective signals ───────────────────────────────────────────
// The agent must find the scanner activity, the 5xx cluster, and the 429.
// This is the anti-vagueness anchor — an analysis that says "there are some
// errors" without naming the IP, endpoint, or status codes fails here.
check("detected-planted-anomalies", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, EXPECTED_SIGNALS);

  t.check(
    deliverables.result.findings.length,
    satisfies((n: number) => n >= 2, "at least 2 distinct findings"),
  );
  t.check(
    deliverables.stats.total_tool_calls,
    satisfies((n: number) => n >= 2, "used at least 2 tools"),
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: scanner detection. Did the agent identify the scanner as a
// COHERENT pattern (same IP + suspicious paths + python-requests UA), or
// just list individual log lines without connecting them? Pattern
// recognition is the core skill here.
check("identified-scanner-as-pattern", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the analysis identifies the scanner activity as a coherent pattern: IP 45.33.32.156 probing /admin, /admin/users, /.env, /wp-admin with a python-requests user-agent — characterizing it as reconnaissance or scanning behaviour, not just listing individual requests. FAIL if the scanner IP is mentioned without connecting it to the suspicious paths and user-agent pattern.",
  );
});

// Judge B: error cluster detection. Did the agent identify the 5xx cluster
// as a SERVICE issue (POST /api/v2/orders failing repeatedly from 10.0.0.51),
// not just "there are some 500 errors"? Contextualization matters — is it
// a transient blip or a systematic failure?
check("contextualized-error-cluster", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the analysis identifies the cluster of 500/503 errors on POST /api/v2/orders from 10.0.0.51 as a service-level issue (not just individual error lines), AND notes the 429 rate-limit response to the scanner IP as a separate signal. FAIL if 5xx errors are mentioned without identifying the endpoint pattern, or if the 429 is not flagged.",
  );
});

// Judge C: analysis specificity. Does the analysis cite concrete data
// (percentages, counts, IP addresses, time ranges), or is it generic
// ("high traffic detected")? Specificity is what makes an SRE analysis
// actionable.
check("analysis-is-specific-and-actionable", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the analysis cites specific data points — request counts, status-code distributions, IP addresses, endpoint breakdowns, timestamps — and categorizes findings into clear sections (normal traffic, anomalies, attacks, errors). FAIL if findings are generic like 'high traffic' or 'some errors' without concrete numbers, IPs, or endpoints.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("log-file-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("access.log"));
});
