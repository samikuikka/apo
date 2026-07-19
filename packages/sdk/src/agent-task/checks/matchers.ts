/**
 * Value matchers for `t.check(value, matcher)`. Small, composable, and the
 * single way to assert on deliverables/values (replaces the old `expect`).
 *
 * A matcher is just `{ label, test }` — easy to build custom ones inline with
 * `satisfies(fn, label)`.
 */

export type Matcher<T> = { label: string; test: (value: T) => boolean };

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Serialize any value for compact "Received:" display. */
export function describeValue(value: unknown): string {
  return asString(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]),
  );
}

/** Coerces the value to a string and checks it contains a substring or RegExp. Gate. */
export function includes(needle: string | RegExp): Matcher<unknown> {
  const re = typeof needle === "string" ? new RegExp(escapeRegExp(needle)) : needle;
  return {
    label: `includes ${needle instanceof RegExp ? needle.source : needle}`,
    test: (v) => re.test(asString(v)),
  };
}

/** Deep structural equality. Gate. */
export function equals<T>(expected: T): Matcher<T> {
  return {
    label: `equals ${asString(expected)}`,
    test: (v) => deepEqual(v, expected),
  };
}

/**
 * Validates against a Standard-Schema-shaped validator (Zod, Valibot, …) —
 * anything exposing `safeParse`. Gate.
 */
export function matches<T = unknown>(
  schema: {
    safeParse: (value: unknown) => { success: boolean };
  },
): Matcher<T> {
  return {
    label: "matches schema",
    test: (v) => schema.safeParse(v).success === true,
  };
}

/** Custom boolean predicate. Gate. */
export function satisfies<T>(
  predicate: (value: T) => boolean,
  label: string,
): Matcher<T> {
  return { label, test: predicate };
}

// ── Value matching (for tool-call input/output fields) ───────────────────
// A value can be matched by a literal (partial-deep for objects), a RegExp
// (string-coerced), or a predicate function. Used by calledTool/notCalledTool
// to match a tool call's input/output/status.

export type ValueMatcher<T> = T | RegExp | ((value: T) => boolean);

export function matchValue<T>(actual: T, matcher: ValueMatcher<T>): boolean {
  if (matcher instanceof RegExp) return matcher.test(asString(actual));
  if (typeof matcher === "function") {
    return (matcher as (value: T) => boolean)(actual);
  }
  if (matcher !== null && typeof matcher === "object") {
    // Partial-deep match: every key on the matcher must be present and match.
    if (actual === null || typeof actual !== "object") return false;
    const a = actual as Record<string, unknown>;
    const m = matcher as Record<string, unknown>;
    return Object.keys(m).every(
      (k) =>
        Object.prototype.hasOwnProperty.call(a, k) && matchValue(a[k], m[k]),
    );
  }
  return deepEqual(actual, matcher);
}

// ── Fuzzy similarity ─────────────────────────────────────────────────────

/** Normalized Levenshtein similarity. Pass when score ≥ threshold (default 0.8). */
export function similarity(expected: string, threshold = 0.8): Matcher<unknown> {
  return {
    label: `similar to "${expected}" (≥ ${threshold})`,
    test: (v) => normalizedSimilarity(asString(v), expected) >= threshold,
  };
}

function normalizedSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, () => 0);
  let curr = Array.from({ length: n + 1 }, () => 0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
