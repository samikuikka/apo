import type {
  CheckAssertionResult,
  CheckLocation,
  CheckResult,
} from "./agent-task-types.ts";
import { dim, green, passFail, red } from "./format.ts";

/**
 * Issue #8: shown when a run ends with zero registered checks. A bare
 * `FAIL <task>` with no Checks section looked like a real failure but was
 * almost always a silent registration bug (e.g. a double-import that wiped
 * the check registry). Naming `test()` matches the documented registration
 * function — `apps/docs` reference/task.md.
 *
 * Kept in sync with the SDK's copy in `packages/sdk/src/agent-task/run/aggregate.ts`.
 * The CLI can't import the SDK's constant directly because vitest resolves
 * `@apo/sdk/agent-task` without the `development` export condition (no source
 * build in tests), so the value would be `undefined` at test time.
 */
export const NO_CHECKS_REGISTERED_MESSAGE =
  "No tests were registered by the eval module — a task must define at least one test().";

/**
 * Render a run's `checks_json` section, terminal-style.
 *
 * Passing checks stay compact (`✓ id`) so failures stand out. Failing checks
 * expand to show every failing assertion with its `− Expected` / `+ Received`
 * diff and source location — the "what went wrong and where" that agents (and
 * humans) need to self-diagnose a failure without opening the dashboard.
 *
 * The diff markers mirror the dashboard (and Jest/Vitest): `− Expected` is the
 * green target, `+ Received` is the red actual value.
 *
 * Set `verbose` to also render passing assertions and LLM-judge metadata.
 */
export function formatChecks(checks: CheckResult[], verbose = false): string {
  return checks.map((c) => formatCheck(c, verbose)).join("\n");
}

function formatCheck(check: CheckResult, verbose: boolean): string {
  const lines: string[] = [];
  lines.push(`    ${passFail(check.pass)} ${check.id}`);

  // Always show reasoning for failures; for passes only when verbose.
  if (check.reasoning && (!check.pass || verbose)) {
    lines.push(dim(`      ${check.reasoning}`));
  }

  const assertions = check.assertions ?? [];
  const shown = verbose ? assertions : assertions.filter((a) => !a.pass);
  for (const a of shown) {
    lines.push(formatAssertion(a));
  }

  // Check-level failure with no assertion breakdown (e.g. an LLM-judged check):
  // surface its own location and, in verbose mode, the judge response.
  if (!check.pass && assertions.length === 0) {
    if (check.location) {
      lines.push(dim(`      at ${formatLocation(check.location)}`));
    }
    if (verbose && check.judge?.response) {
      const model = check.judge.model ?? "?";
      lines.push(dim(`      judge (${model}): ${trunc(check.judge.response, 400)}`));
    }
  }

  return lines.join("\n");
}

function formatAssertion(a: CheckAssertionResult): string {
  const lines: string[] = [];
  const mark = a.pass ? green("✓") : red("✗");
  lines.push(`      ${mark} ${a.id}`);
  if (a.location) {
    lines.push(dim(`        ${formatLocation(a.location)}`));
  }
  // Structured diff takes priority over prose reasoning. `received` is a
  // string for code assertions but may be a raw value (object/array/prose)
  // for LLM judges — stringify anything that isn't already a string.
  if (a.expected != null) {
    lines.push(green(`        − Expected: ${a.expected}`));
  }
  const receivedStr = typeof a.received === "string"
    ? a.received
    : a.received != null ? JSON.stringify(a.received) : undefined;
  if (receivedStr != null) {
    lines.push(red(`        + Received: ${receivedStr}`));
  }
  if (a.expected == null && a.received == null && a.reasoning) {
    lines.push(dim(`        ${a.reasoning}`));
  }
  return lines.join("\n");
}

function formatLocation(loc: CheckLocation): string {
  const base = `${loc.file}:${loc.line}`;
  return loc.column != null ? `${base}:${loc.column}` : base;
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
