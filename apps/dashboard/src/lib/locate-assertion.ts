/**
 * Robustly locate an assertion's source line within its check's code block.
 *
 * The recorder stores a stack-trace-derived line per assertion, but those are
 * fragile: V8 attributes multi-line/async calls to surprising lines, and any
 * edit to ``checks.ts`` shifts stored line numbers so a marker can land on a
 * comment or the wrong assertion. Instead we re-derive the line from the
 * CURRENT source by matching the assertion's method (and a key argument token
 * when one is available). This is immune to both stack-trace weirdness and
 * file edits — what the dashboard renders is what we search.
 *
 * Returns a 1-indexed line within ``blockCode``, or ``undefined`` when no
 * match is found (callers fall back to the stored stack-trace location).
 */

/** Extract the `t.<method>` name from a recorder assertion id. */
function methodFromId(id: string): string | undefined {
  // "calledTool(\"x\")" / "maxToolCalls(40)" / "notCalledTool(/re/)"
  const call = id.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (call) return call[1];
  // No parens — the id is the bare method name ("noFailedActions", "judge").
  if (/^[A-Za-z_$][\w$]*$/.test(id)) return id;
  // Anything else (custom `t.assert`/`t.check` labels) can't be matched.
  return undefined;
}

/**
 * A token used to disambiguate same-method assertions. Only returns
 * letter-bearing tokens (strings, regex alts, identifiers) — pure numbers are
 * dropped because the source likely uses a named constant (40 vs MAX_TOOL_CALLS).
 */
function tokenFromId(id: string): string | undefined {
  // Quoted argument: calledTool("read_file") / messageIncludes("X")
  const quoted = id.match(/["'`]([^"'`]+)["'`]/);
  if (quoted && /[A-Za-z]/.test(quoted[1])) return quoted[1];

  // Regex argument: notCalledTool(/^(write_file|delete_file)$/) -> write_file
  const regexAlt = id.match(/\/\^?\(?\(([^)/]+)/);
  if (regexAlt) {
    const first = regexAlt[1].split("|")[0].replace(/[^\w.]/g, "");
    if (first.length >= 3 && /[A-Za-z]/.test(first)) return first;
  }

  // Arrow / list argument: toolOrder(read_file → search_content) -> read_file
  const grouped = id.match(/\(([^)]*)\)/);
  if (grouped) {
    const first = grouped[1].split(/[→,\s]/)[0];
    if (first && /[A-Za-z]/.test(first) && first.length >= 2) return first;
  }

  return undefined;
}

/**
 * Find the line (1-indexed) of the `t.<method>(…)` call matching the
 * assertion id. Prefers a line that also contains the argument token; falls
 * back to the first method-name match.
 */
export function locateAssertionInBlock(
  blockCode: string,
  assertionId: string,
): number | undefined {
  const method = methodFromId(assertionId);
  if (!method) return undefined;
  const token = tokenFromId(assertionId);
  const lines = blockCode.split("\n");
  // `await t.judge(`, `t.calledTool(`, etc.
  const methodRe = new RegExp(`(^|[^.\\w])((await\\s+)?)t\\.${method}\\s*\\(`);

  let methodOnlyLine: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!methodRe.test(lines[i])) continue;
    if (token) {
      if (lines[i].includes(token)) return i + 1;
    } else if (methodOnlyLine === undefined) {
      methodOnlyLine = i + 1;
    }
  }
  // Only fall back to a method-only match when there was no disambiguating
  // token. If a token was present but matched nothing, the assertion isn't on
  // a recognizable line — return undefined so callers use the stored location.
  return token ? undefined : methodOnlyLine;
}

/**
 * Locate MULTIPLE assertions that may share the same method name (e.g. two
 * `t.judge()` calls). Assigns the Nth occurrence in the source to the Nth
 * assertion with that method — so the first `t.judge()` maps to line A and
 * the second to line B, not both to A.
 *
 * Returns one 1-indexed line per assertion (or ``undefined`` per assertion).
 */
export function locateAssertionsInBlock(
  blockCode: string,
  assertions: Array<{ id: string }>,
): Array<number | undefined> {
  const lines = blockCode.split("\n");
  const results: Array<number | undefined> = Array.from({ length: assertions.length }, () => undefined);
  // Tracks claimed line numbers alongside `results` for O(1) lookup in loops.
  const claimed = new Set<number>();

  // Group assertion indices by method name.
  const methodGroups = new Map<string, number[]>();
  for (let i = 0; i < assertions.length; i++) {
    const method = methodFromId(assertions[i].id);
    if (method) {
      const group = methodGroups.get(method) ?? [];
      group.push(i);
      methodGroups.set(method, group);
    }
  }

  for (const [method, indices] of methodGroups) {
    // Find every line where `t.<method>(` appears, in order.
    const methodRe = new RegExp(`(^|[^.\\w])((await\\s+)?)t\\.${method}\\s*\\(`);
    const matchingLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (methodRe.test(lines[i])) matchingLines.push(i + 1);
    }

    // Assign by occurrence: 1st assertion → 1st match, 2nd → 2nd, etc.
    for (let j = 0; j < indices.length; j++) {
      const assertionIdx = indices[j];
      const token = tokenFromId(assertions[assertionIdx].id);

      if (token) {
        // Try to match by disambiguating token first.
        const tokenLine = matchingLines.find(
          (l) => !claimed.has(l) && lines[l - 1].includes(token),
        );
        if (tokenLine !== undefined) claimed.add(tokenLine);
        results[assertionIdx] = tokenLine;
      }

      if (results[assertionIdx] === undefined && j < matchingLines.length) {
        // Fall back to occurrence-order assignment. Skip lines already
        // claimed by a previous assertion (handles same-line edge cases).
        for (const candidate of matchingLines) {
          if (!claimed.has(candidate)) {
            claimed.add(candidate);
            results[assertionIdx] = candidate;
            break;
          }
        }
      }
    }
  }

  return results;
}
