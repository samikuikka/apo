import type {
  CheckAssertionResult,
  CheckLocation,
  CheckResult,
} from "./agent-task-types.ts";
import { dim, green, passFail, red, yellow } from "./format.ts";
import { RECEIVED_PREVIEW_CHARS, previewString } from "./runs-truncate.ts";

//─ Second judge: measurements, not diagnoses ──────────────────────────
//
// The same language as the dashboard run page: corroborated checks stay
// silent; a split shows both verdicts plus the second judge's confidence
// (the number is the measurement — no label claims *why* they differ).

type SecondJudgeFacts =
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "split"; confidence: number }
  | { kind: "agree"; confidence: number }
  | { kind: "unsure"; confidence: number };

export function secondJudgeFacts(check: CheckResult): SecondJudgeFacts {
  const sj = check.judge?.secondJudge;
  if (!sj) return { kind: "none" };
  if (sj.error || sj.choice == null) return { kind: "error" };
  const conf = sj.confidence ?? 0;
  if ((sj.choice === "pass") !== check.pass) return { kind: "split", confidence: conf };
  if (conf < 0.6) return { kind: "unsure", confidence: conf };
  return { kind: "agree", confidence: conf };
}

/** Row suffix: `✓✗ 0.99` (amber) for splits, `✓✓ ·0.31` (dim) for unsure,
 *  `2nd ✕` for a failed second opinion, empty when corroborated. */
function secondJudgeMark(check: CheckResult): string {
  const sj = check.judge?.secondJudge;
  const facts = secondJudgeFacts(check);
  if (facts.kind === "split" || facts.kind === "unsure") {
    const primary = check.pass ? green("✓") : red("✗");
    const second = sj!.choice === "pass" ? green("✓") : red("✗");
    const num = facts.confidence.toFixed(2);
    return facts.kind === "split"
      ? ` ${primary}${second} ${yellow(num)}`
      : ` ${dim(`${check.pass ? "✓" : "✗"}${sj!.choice === "pass" ? "✓" : "✗"} ·${num}`)}`;
  }
  if (facts.kind === "error") return ` ${dim("2nd ✕")}`;
  return "";
}

/** One honest sentence about the relation — the same takeaway the dashboard expand shows. */
function secondJudgeTakeaway(check: CheckResult): string | null {
  const facts = secondJudgeFacts(check);
  switch (facts.kind) {
    case "split":
      return `Verdicts differ — second judge contradicts at ${facts.confidence.toFixed(2)} confidence.`;
    case "unsure":
      return `Second judge unsure (${facts.confidence.toFixed(2)}) — weak corroboration.`;
    case "error":
      return `Second opinion failed to arrive${check.judge?.secondJudge?.error ? ` (${check.judge.secondJudge.error})` : ""}.`;
    default:
      return null;
  }
}

/** Run-level fact line, or null when no second judge ran on any check. */
export function secondJudgeSummary(checks: CheckResult[]): string | null {
  let split = 0;
  let unsure = 0;
  let corroborated = 0;
  for (const c of checks) {
    const f = secondJudgeFacts(c);
    if (f.kind === "split") split++;
    else if (f.kind === "unsure") unsure++;
    else if (f.kind === "agree") corroborated++;
  }
  const judged = split + unsure + corroborated;
  if (judged === 0) return null;
  const parts = [`${corroborated} corroborated`];
  if (split > 0) parts.push(`judges split on ${split}`);
  if (unsure > 0) parts.push(`${unsure} unsure`);
  return `Second judge: ${parts.join(" · ")}`;
}

/**
 * Issue #8: shown when a run ends with zero registered checks. A bare
 * `FAIL <task>` with no Checks section looked like a real failure but was
 * almost always a silent registration bug (e.g. a double-import that wiped
 * the check registry). Naming `test()` matches the documented registration
 * function — `apps/docs` reference/task.md.
 *
 * Kept in sync with the SDK's copy in `packages/sdk/src/agent-task/run/aggregate.ts`.
 * The CLI can't import the SDK's constant directly because vitest resolves
 * `@apo-ai/sdk/agent-task` without the `development` export condition (no source
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
 *
 * Large `received` values (typically the deliverable re-sent per criterion)
 * are replaced by a one-line manifest pointing at `apo runs deliverable`,
 * which fetches the content once instead of re-dumping it per check (#22).
 */
export function formatChecks(checks: CheckResult[], verbose = false): string {
  // nest checks declared inside a describe() under a roll-up header.
  // Bare checks (no group_id) render as before, so old output is unchanged.
  const segments = groupChecks(checks);
  const lines: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "check") {
      lines.push(formatCheck(segment.check, verbose));
      continue;
    }
    const passed = segment.checks.filter((c) => c.pass === true).length;
    const total = segment.checks.length;
    const verdict = passed === total ? green(`${passed}/${total}`) : `${red(String(passed))}/${total}`;
    lines.push(`  ${dim("▾")} ${segment.groupName} ${dim(`· ${verdict}`)}`);
    for (const check of segment.checks) {
      lines.push(formatCheck(check, verbose));
    }
  }
  return lines.join("\n");
}

type CheckSegment =
  | { kind: "check"; check: CheckResult }
  | { kind: "group"; groupName: string; checks: CheckResult[] };

/** Partition checks into bare + grouped segments in declaration order. */
function groupChecks(checks: CheckResult[]): CheckSegment[] {
  const segments: CheckSegment[] = [];
  const index = new Map<string, number>();
  for (const check of checks) {
    const groupId = check.group_id;
    if (!groupId) {
      segments.push({ kind: "check", check });
      continue;
    }
    const existing = index.get(groupId);
    if (existing !== undefined) {
      (segments[existing] as Extract<CheckSegment, { kind: "group" }>).checks.push(check);
    } else {
      index.set(groupId, segments.length);
      segments.push({
        kind: "group",
        groupName: check.group_name ?? groupId,
        checks: [check],
      });
    }
  }
  return segments;
}

function formatCheck(check: CheckResult, verbose: boolean): string {
  const lines: string[] = [];
  // Corrected tests carry their effective verdict with the
  // recorded one and the correction provenance one line below.
  if (check.correction && check.recorded_pass !== undefined) {
    lines.push(
      `    ${passFail(check.pass)} ${check.id} ${yellow("(corrected)")}${secondJudgeMark(check)}`,
    );
    const recorded = check.recorded_pass ? "PASS" : "FAIL";
    const who = check.correction.corrected_by_label ?? check.correction.corrected_by_user_id ?? "unknown";
    lines.push(
      dim(
        `      recorded ${recorded} · corrected by ${who}: ${check.correction.reason}`,
      ),
    );
  } else {
    lines.push(`    ${passFail(check.pass)} ${check.id}${secondJudgeMark(check)}`);
  }

  // The second-judge relation is signal, not decoration — splits and unsure
  // cases get their takeaway even without --verbose.
  const takeaway = secondJudgeTakeaway(check);
  if (takeaway) {
    lines.push(check.pass && secondJudgeFacts(check).kind === "split"
      ? yellow(`      ${takeaway}`)
      : dim(`      ${takeaway}`));
  }
  const sj = check.judge?.secondJudge;
  if (verbose && sj && !sj.error && sj.choice != null) {
    const parts = [
      `${sj.choice.toUpperCase()}`,
      sj.passProbability != null ? `p(pass) ${sj.passProbability.toFixed(2)}` : null,
      sj.confidence != null ? `conf ${sj.confidence.toFixed(2)}` : null,
      sj.latencyMs != null ? `${sj.latencyMs}ms` : null,
      sj.costUsd != null ? `$${sj.costUsd.toFixed(6)}` : null,
    ].filter((p): p is string => p != null);
    lines.push(dim(`      2nd judge (${sj.model}): ${parts.join(" · ")}`));
  }

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
    // Issue #22: a judge `received` is often the entire deliverable (tens of
    // KB). Replace it with a manifest pointing at `apo runs deliverable`,
    // which reads the content once rather than per check.
    lines.push(red(`        + Received: ${previewString(receivedStr, RECEIVED_PREVIEW_CHARS)}`));
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
