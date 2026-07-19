/**
 * Extract a single `test("id", …)` block from a checks source file — so each
 * code check can show *its own* code (with the failing line marked) instead
 * of the whole file.
 *
 * Anchoring: prefer the failure line (``anchorLine``) when present — scan
 * back to the nearest check opener and brace-match forward. Fall back to
 * matching the check ``id`` literally.
 *
 * Alias-aware: checks may be registered via a typed alias such as
 * `const check = test<Deliverables>; check("id", …)`. Such aliases are
 * detected and treated as openers alongside the built-in `test`/`defineCheck`.
 * Brace matching is string/comment aware so braces inside string literals or
 * comments don't fool it.
 */

export interface CheckBlock {
  code: string;
  /** 1-indexed line in the original file where the block starts. */
  startLine: number;
  /** 1-indexed line in the original file where the block ends. */
  endLine: number;
}

const BASE_OPENER_NAMES = ["test", "defineCheck"];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect opener identifiers: the built-ins plus any
 * `const <alias> = test…` / `const <alias> = defineCheck…` aliases declared
 * in the file (e.g. `const check = test<Deliverables>;`).
 */
function collectOpenerNames(source: string): string[] {
  const names = new Set<string>(BASE_OPENER_NAMES);
  const aliasRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:test|defineCheck)\b/g;
  let m: RegExpExecArray | null;
  while ((m = aliasRe.exec(source)) !== null) {
    names.add(m[1]);
  }
  return [...names];
}

export function extractCheckBlock(
  source: string,
  opts: { id?: string; anchorLine?: number },
): CheckBlock | null {
  if (!source) return null;
  const lines = source.split("\n");

  const openerNames = collectOpenerNames(source);
  const startIdx = findOpener(lines, opts, openerNames);
  if (startIdx === -1) return null;

  const endIdx = findBlockEnd(lines, startIdx);
  if (endIdx === -1) return null;

  return {
    code: lines.slice(startIdx, endIdx + 1).join("\n"),
    startLine: startIdx + 1,
    endLine: endIdx + 1,
  };
}

function findOpener(
  lines: string[],
  opts: { id?: string; anchorLine?: number },
  openerNames: string[],
): number {
  const namesAlt = openerNames.map(escapeRegex).join("|");
  const openerRe = new RegExp(`^\\s*(?:${namesAlt})\\s*\\(`);

  // 1) Match the id literally FIRST. Check ids are unique and always appear at
  // the registration call (`check("id", …)`), so this is precise AND robust to
  // a stale anchorLine (e.g. checks.ts edited after the run shifted lines).
  const id = opts.id?.trim();
  if (id) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoteClass = "[\"'`]";
    const idRe = new RegExp(
      `^\\s*(?:${namesAlt})\\s*\\([^\\n]*${quoteClass}${escaped}${quoteClass}`,
    );
    for (let i = 0; i < lines.length; i++) {
      if (idRe.test(lines[i])) return i;
    }
    // Defensive: ANY identifier-call whose first quoted argument is the id, so
    // future aliases work without updating this file.
    const anyCallRe = new RegExp(
      `^\\s*[\\w$]+\\s*\\(\\s*${quoteClass}${escaped}${quoteClass}`,
    );
    for (let i = 0; i < lines.length; i++) {
      if (anyCallRe.test(lines[i])) return i;
    }
    // Looser fallback: opener on its own line, id nearby.
    for (let i = 0; i < lines.length; i++) {
      if (openerRe.test(lines[i]) && lines[i].includes(id)) return i;
    }
  }
  // 2) Anchor on the failure line: nearest opener at or before it (fallback
  // when no id was provided, or the id genuinely isn't in the source).
  if (typeof opts.anchorLine === "number" && opts.anchorLine >= 1) {
    for (let i = opts.anchorLine - 1; i >= 0; i--) {
      if (openerRe.test(lines[i])) return i;
    }
  }
  return -1;
}

/**
 * From the opener line, find the matching close by counting braces, ignoring
 * braces inside string/template literals and comments. Returns the line index
 * of the closing `}` (the block usually ends `});` on that line).
 */
function findBlockEnd(lines: string[], startIdx: number): number {
  type State = "code" | "sq" | "dq" | "tpl" | "lineComment" | "blockComment";
  let state: State = "code";
  // Track parenthesis depth so braces inside the check's argument list —
  // e.g. the `(t, { deliverables })` destructure — are NOT mistaken for the
  // body. The body-open `{` is the first `{` at the call's own paren level
  // (parenDepth === 1), i.e. the one after the arrow/function params.
  let parenDepth = 0;
  let braceDepth = 0;
  let seenOpen = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      const next = line[j + 1];

      if (state === "blockComment") {
        if (c === "*" && next === "/") {
          state = "code";
          j++;
        }
        continue;
      }
      if (state === "sq") {
        if (c === "\\") j++;
        else if (c === "'") state = "code";
        continue;
      }
      if (state === "dq") {
        if (c === "\\") j++;
        else if (c === '"') state = "code";
        continue;
      }
      if (state === "tpl") {
        if (c === "\\") j++;
        else if (c === "`") state = "code";
        continue;
      }
      // state === "code"
      if (c === "/" && next === "/") break; // rest of line is comment
      if (c === "/" && next === "*") {
        state = "blockComment";
        j++;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        state = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
        continue;
      }
      if (c === "(") {
        parenDepth++;
        continue;
      }
      if (c === ")") {
        parenDepth--;
        continue;
      }
      if (c === "{") {
        if (!seenOpen) {
          // Only the `{` at the call level (parenDepth 1) opens the body;
          // braces nested in the argument list (destructures, etc.) are skipped.
          if (parenDepth === 1) {
            seenOpen = true;
            braceDepth = 1;
          }
        } else {
          braceDepth++;
        }
        continue;
      }
      if (c === "}" && seenOpen) {
        braceDepth--;
        if (braceDepth === 0) return i; // body close — block ends here (`});`)
        continue;
      }
    }
    state = "code"; // line comments / strings don't carry across lines
  }
  return -1;
}
