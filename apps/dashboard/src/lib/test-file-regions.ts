/**
 * Region model for showing a task's WHOLE eval file (`*.eval.ts`) on a run
 * page: scan the file into `describe`/`test` regions, map the run's recorded
 * checks onto the region that declares them, and derive lint-style marks so
 * one continuous code view can carry the run's verdicts: green opener line
 * for passed tests, red opener line plus failing assertion lines for failed
 * ones, amber opener line for tests with no recorded result in this run.
 */

import type { CheckResult, TaskFileContentResponse } from "@/lib/agent-task-api";
import type { CodeDiagnostic } from "@/components/CodeViewer";
import { extractCheckBlock, resolveCheckBlock, type CheckBlock } from "./extract-check-block";
import { formatAssertionValue } from "./format-assertion-value";

export interface TestFileRegion {
  kind: "describe" | "test";
  /** First quoted argument of the opener call (may be empty for odd sources). */
  name: string;
  /** 1-indexed, inclusive, over the whole file. */
  startLine: number;
  endLine: number;
  code: string;
  /** Recorded checks mapped onto this region (table-driven evals can map several). */
  checks: CheckResult[];
  children: TestFileRegion[];
}

export interface TestFileModel {
  source: TaskFileContentResponse;
  /** Top-level regions in file order; code between them is implied by line gaps. */
  regions: TestFileRegion[];
  /** Recorded checks whose declaring block could not be located in the file. */
  unmapped: CheckResult[];
}

export type TestRegionVerdict = "pass" | "fail" | "no-result";

const DESCRIBE_OPENER_RE = /^\s*describe\s*\(/;
const ALIAS_DECL_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:test|defineCheck)\b/g;

/** Collect opener identifiers: the built-ins plus typed aliases declared in
 *  the file (e.g. `const check = test<Deliverables>;`), mirroring
 *  extract-check-block so both scanners agree on what opens a test. */
function collectOpenerNames(content: string): string[] {
  const names = new Set(["test", "defineCheck"]);
  let m: RegExpExecArray | null;
  ALIAS_DECL_RE.lastIndex = 0;
  while ((m = ALIAS_DECL_RE.exec(content)) !== null) {
    names.add(m[1]);
  }
  return [...names];
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First quoted argument on a line, escapes flattened: the test/describe title. */
function firstQuotedArg(line: string): string {
  const m = line.match(/(["'`])(?:\\.|(?!\1)[^\\])*\1/);
  if (!m) return "";
  return m[0].slice(1, -1).replace(/\\(.)/g, "$1");
}

/** Remove line comments and quoted spans so paren counting sees only code.
 *  Multi-line template literals reset at each line; eval files keep their
 *  `test(`/`describe(` openers and closers outside such literals, so this is
 *  enough for region boundaries. */
function stripLineForScan(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") break;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === "\\") i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Closing line (0-indexed) of the call opened on startIdx: paren depth back to zero. */
function findCallEndLine(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of stripLineForScan(lines[i])) {
      if (ch === "(") {
        depth++;
        started = true;
      } else if (ch === ")") {
        depth--;
      }
    }
    if (started && depth <= 0) return i;
  }
  return startIdx;
}

interface ScannedRegion {
  kind: "describe" | "test";
  name: string;
  block: CheckBlock;
}

/** Find every `describe(...)` and `test(...)` opener in the file and slice its block. */
function scanRegions(content: string): ScannedRegion[] {
  const lines = content.split("\n");
  const namesAlt = collectOpenerNames(content)
    .map(escapeRegExp)
    .join("|");
  const testOpenerRe = new RegExp(`^\\s*(?:${namesAlt})\\s*\\(`);
  const scanned: ScannedRegion[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (DESCRIBE_OPENER_RE.test(lines[i])) {
      const end = findCallEndLine(lines, i);
      scanned.push({
        kind: "describe",
        name: firstQuotedArg(lines[i]),
        block: {
          code: lines.slice(i, end + 1).join("\n"),
          startLine: i + 1,
          endLine: end + 1,
        },
      });
    } else if (testOpenerRe.test(lines[i])) {
      // Anchor on the opener's own line so extractCheckBlock returns exactly
      // this block (its brace matching is string/comment aware for free).
      const block = extractCheckBlock(content, { anchorLine: i + 1 });
      if (block) {
        scanned.push({ kind: "test", name: firstQuotedArg(lines[i]), block });
      }
    }
  }
  return scanned;
}

/** Nest scanned blocks by containment (a stack over document order). */
function buildTree(scanned: ScannedRegion[]): TestFileRegion[] {
  const sorted = [...scanned].sort(
    (a, b) => a.block.startLine - b.block.startLine,
  );
  const roots: TestFileRegion[] = [];
  const stack: TestFileRegion[] = [];
  for (const s of sorted) {
    const region: TestFileRegion = {
      kind: s.kind,
      name: s.name,
      startLine: s.block.startLine,
      endLine: s.block.endLine,
      code: s.block.code,
      checks: [],
      children: [],
    };
    while (
      stack.length > 0 &&
      stack[stack.length - 1].endLine < region.startLine
    ) {
      stack.pop();
    }
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(region);
    } else {
      roots.push(region);
    }
    stack.push(region);
  }
  return roots;
}

function flattenRegions(regions: TestFileRegion[]): TestFileRegion[] {
  const out: TestFileRegion[] = [];
  const walk = (r: TestFileRegion) => {
    out.push(r);
    r.children.forEach(walk);
  };
  regions.forEach(walk);
  return out;
}

/** Attach recorded checks to their declaring region; unresolvable ones land in `unmapped`. */
function mapChecksOntoRegions(
  content: string,
  regions: TestFileRegion[],
  checks: CheckResult[],
): CheckResult[] {
  const unmapped: CheckResult[] = [];
  const all = flattenRegions(regions);
  const byStartLine = new Map(all.map((r) => [r.startLine, r] as const));
  for (const check of checks) {
    const block = resolveCheckBlock(content, {
      id: check.id,
      anchorFrom: [check],
    });
    let target = block ? byStartLine.get(block.startLine) : undefined;
    if (!target && block) {
      // Generated-title checks (table-driven evals): settle for the deepest
      // test block containing the resolved start line.
      for (const r of all) {
        if (
          r.kind === "test" &&
          r.startLine <= block.startLine &&
          block.startLine <= r.endLine
        ) {
          target = r;
        }
      }
    }
    if (target) target.checks.push(check);
    else unmapped.push(check);
  }
  return unmapped;
}

export function buildTestFileModel(
  source: TaskFileContentResponse,
  checks: CheckResult[],
): TestFileModel {
  const regions = buildTree(scanRegions(source.content));
  const unmapped = mapChecksOntoRegions(source.content, regions, checks);
  return { source, regions, unmapped };
}

/** A region's verdict from its recorded checks: all passed, something failed,
 *  or nothing recorded in this run. */
export function testRegionVerdict(region: TestFileRegion): TestRegionVerdict {
  if (region.checks.length === 0) return "no-result";
  return region.checks.every((c) => c.pass === true) ? "pass" : "fail";
}

function regionLabel(region: TestFileRegion): string {
  return region.name || `test at line ${region.startLine}`;
}

function testRegionDiagnostics(region: TestFileRegion): CodeDiagnostic[] {
  if (region.checks.length === 0) {
    return [
      {
        line: region.startLine,
        severity: "warning",
        message: `${regionLabel(region)}: no result in this run`,
      },
    ];
  }
  const failing = region.checks.filter((c) => c.pass !== true);
  if (failing.length === 0) {
    return [
      { line: region.startLine, severity: "info", message: `${regionLabel(region)} passed` },
    ];
  }
  const diagnostics: CodeDiagnostic[] = [
    {
      line: region.startLine,
      severity: "error",
      message: `${regionLabel(region)} failed`,
      reasoning: failing.find((c) => typeof c.reasoning === "string" && c.reasoning)
        ?.reasoning,
    },
  ];
  for (const check of failing) {
    for (const assertion of check.assertions ?? []) {
      // Only assertion locations inside the region's own lines: a location
      // pointing at another file or helper would mark an unrelated line.
      if (assertion.pass !== false) continue;
      const line = assertion.location?.line;
      if (!line || line < region.startLine || line > region.endLine) continue;
      diagnostics.push({
        line,
        severity: "error",
        message: assertion.reasoning || `${assertion.id} failed`,
        label: assertion.id,
        expected: assertion.expected,
        received:
          assertion.received == null
            ? undefined
            : formatAssertionValue(assertion.received),
      });
    }
  }
  return diagnostics;
}

/** Lint marks for the whole file: one mark per `test(` opener line (verdict
 *  colored) plus one red mark per failing assertion's located line. Describe
 *  lines carry no marks; nesting only decides which checks belong where. */
export function buildFileDiagnostics(model: TestFileModel): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];
  const walk = (regions: TestFileRegion[]) => {
    for (const region of regions) {
      if (region.kind === "test") {
        diagnostics.push(...testRegionDiagnostics(region));
      }
      walk(region.children);
    }
  };
  walk(model.regions);
  return diagnostics;
}
