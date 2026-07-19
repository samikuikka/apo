/**
 * security-audit — the hardest task. Demonstrates two fact tables + coverage
 * ratio + multiple judges.
 *
 * Security auditing requires finding ALL vulnerability classes, not just
 * some. This task splits the expected vulns into two tables (injection vulns
 * vs secrets/crypto/XSS) and uses `t.assert` to compute a coverage ratio
 * across both. The `matches()` matcher validates that findings reference
 * specific code locations.
 *
 * Layers: trajectory → fact table A (injection vulns) → fact table B
 * (secrets/crypto/XSS) → coverage assert → judges (completeness,
 * specificity, severity).
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

task("security-audit", {
  adapter: realAgentAdapter,
  description:
    "Scan source code files for security vulnerabilities including SQL injection, XSS, hardcoded secrets, and insecure patterns.",
  metadata: { category: "security", difficulty: "hard" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

const check = test<RealAgentDeliverables>;

// Table A: injection vulnerabilities. Each function has a SQL injection
// (f-string or string concatenation) except export_data which has command
// injection via os.system.
const INJECTION_VULNS = [
  { label: "SQLi: authenticate_user", pattern: /authenticate_user/ },
  { label: "SQLi: register_user", pattern: /register_user/ },
  { label: "SQLi: get_user_profile", pattern: /get_user_profile/ },
  { label: "SQLi: search_products", pattern: /search_products/ },
  { label: "SQLi: delete_product", pattern: /delete_product/ },
  { label: "SQLi: update_inventory", pattern: /update_inventory/ },
  { label: "SQLi: log_access", pattern: /log_access/ },
  { label: "cmd injection: export_data", pattern: /export_data|os\.system/ },
] as const;

// Table B: secrets, crypto, and XSS vulnerabilities.
const SECRETS_VULNS = [
  { label: "hardcoded SECRET_KEY", pattern: /SECRET_KEY/ },
  { label: "hardcoded DB_PASSWORD", pattern: /DB_PASSWORD/ },
  { label: "hardcoded API_KEY", pattern: /API_KEY/ },
  { label: "hardcoded ADMIN_EMAIL", pattern: /ADMIN_EMAIL/ },
  { label: "weak MD5 hashing", pattern: /md5|MD5/ },
  { label: "XSS in render_profile", pattern: /render_profile|XSS/ },
] as const;

// A schema fragment for a specific finding: must reference either a function
// name or a secret name. Demonstrates `matches()` — schema-validating a
// derived value inside a check.
const specificFindingSchema = z.string().regex(
  /\b(authenticate_user|register_user|get_user_profile|render_profile|search_products|delete_product|update_inventory|export_data|log_access|SECRET_KEY|DB_PASSWORD|API_KEY|md5|os\.system)\b/i,
  { message: "finding must reference a specific function or secret name" },
);

// ── Layer 1: trajectory ──────────────────────────────────────────────────
check("audited-both-files", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { count: 2 });
  t.calledTool("read_file", { input: { path: /auth-handler\.py/ } });
  t.calledTool("read_file", { input: { path: /db-queries\.py/ } });
  t.calledTool("search_content");
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});

// ── Layer 2a: injection vulnerabilities ──────────────────────────────────
check("found-injection-vulnerabilities", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, INJECTION_VULNS);

  // Demonstrate `matches()`: validate that the first finding is specific
  // enough to reference a function or secret name.
  if (deliverables.result.findings.length > 0) {
    t.check(
      deliverables.result.findings[0],
      matches(specificFindingSchema),
      "first finding references a specific function or secret",
    );
  }
});

// ── Layer 2b: secrets, crypto, and XSS ───────────────────────────────────
check("found-secrets-and-crypto-vulns", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  assertFacts(t, findingsText, SECRETS_VULNS);

  t.check(
    deliverables.stats.unique_tools.length,
    satisfies((n: number) => n >= 2, "used at least 2 distinct tools"),
  );
});

// ── Layer 2c: coverage ratio via t.assert ────────────────────────────────
// Combine both tables: of 14 total planted vulns, the agent must catch ≥ 10.
// `t.assert` computes the ratio — the assertion label shows the threshold,
// and if it fails, the per-fact breakdown above shows exactly which were
// missed.
check("caught-majority-of-vulns", (t, { deliverables }) => {
  const findingsText = joinFindings(deliverables.result.findings);
  t.assert(
    `caught at least 10 of 14 planted vulnerabilities`,
    () => {
      const allVulns = [...INJECTION_VULNS, ...SECRETS_VULNS];
      const caught = allVulns.filter((v) => v.pattern.test(findingsText)).length;
      return caught >= 10;
    },
  );
});

// ── Layer 3: judged quality ──────────────────────────────────────────────

// Judge A: completeness. Did the agent find ALL vuln classes — injection,
// secrets, crypto, AND XSS? The fact tables check individual signals; this
// judge assesses whether the audit is comprehensive across vulnerability
// categories and doesn't fabricate vulns that don't exist.
check("audit-is-comprehensive", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if the audit covers ALL vulnerability classes present in the code: SQL injection (in authenticate_user, register_user, get_user_profile, search_products, delete_product, update_inventory, log_access), command injection (os.system in export_data), hardcoded secrets (SECRET_KEY, DB_PASSWORD, API_KEY, ADMIN_EMAIL), weak MD5 password hashing, and XSS (unescaped user input in render_profile). FAIL if any vulnerability class is entirely missing, or if fabricated vulnerabilities not present in the code are reported.",
  );
});

// Judge B: specificity & severity. Are the findings specific enough to act
// on (file + function + vuln type + severity), or generic ("check for SQL
// injection")? A real security audit needs to be actionable.
check("findings-have-severity-and-location", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if each finding identifies the specific file, function name, vulnerability type, AND assigns a severity level (critical/high/medium/low) with justification — e.g. 'CRITICAL: SQL injection in auth-handler.py:authenticate_user via f-string query — allows authentication bypass'. FAIL if findings lack severity, don't name the function, or are generic like 'SQL injection found'.",
  );
});

// ── Fixture sanity ───────────────────────────────────────────────────────
check("source-files-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("auth-handler.py"));
  t.check(paths, includes("db-queries.py"));
});
