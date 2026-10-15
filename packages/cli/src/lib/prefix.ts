import { cyan, dim } from "./format.ts";

/**
 * A full id or prefix that matched nothing in the runs/batches the CLI can
 * see. This is a local resolution miss — no request for the id itself was
 * ever made — so it must not be reported the way a backend rejection is.
 */
export class UnresolvedIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvedIdError";
  }
}

/** Canonical run/batch ids: 3-letter prefix + 24 lowercase hex (28 chars). */
const CANONICAL_RUN_ID = /^run_[0-9a-f]{24}$/;
const CANONICAL_BATCH_ID = /^bch_[0-9a-f]{24}$/;

export function isCanonicalRunId(id: string): boolean {
  return CANONICAL_RUN_ID.test(id);
}

export function isCanonicalBatchId(id: string): boolean {
  return CANONICAL_BATCH_ID.test(id);
}

export type PrefixResolveResult<T> =
  | { status: "unique"; item: T }
  | { status: "ambiguous"; items: T[] }
  | { status: "none" };

/**
 * Resolve `prefix` against `items` by leading characters of each item's id.
 * Returns "unique" when exactly one id starts with the prefix, "ambiguous"
 * when several do, "none" otherwise. (Like jj/git change-id prefixes.)
 *
 * Case-insensitive: the server-side prefix filter compiles to LIKE, which on
 * SQLite matches without regard to case, so an uppercase `RUN_ABC` must
 * resolve the same run here — silently dropping the server's matches would
 * report "no run" for an id that exists.
 */
export function findByPrefix<T>(
  items: T[],
  prefix: string,
  idOf: (item: T) => string,
): PrefixResolveResult<T> {
  const needle = prefix.toLowerCase();
  const matches = items.filter((it) => idOf(it).toLowerCase().startsWith(needle));
  if (matches.length === 0) return { status: "none" };
  if (matches.length === 1) return { status: "unique", item: matches[0] };
  return { status: "ambiguous", items: matches };
}

const MAX_LISTED_CANDIDATES = 10;

/**
 * The ids an ambiguous prefix matched, capped so a two-character prefix does
 * not print hundreds of ids. `total` is the full match count when it is known
 * to exceed the ids at hand (the server's count of a page it filtered).
 */
export function formatCandidates(ids: string[], total = ids.length): string {
  const shown = ids.slice(0, MAX_LISTED_CANDIDATES);
  const more = Math.max(total, ids.length) - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * For each id (in the ORIGINAL order), the minimum number of leading chars
 * needed to distinguish it from every other id in the set. Floor of 1 so a
 * lone item still shows a highlighted char.
 */
export function uniquePrefixLengths(ids: string[]): number[] {
  const n = ids.length;
  if (n === 0) return [];
  const order = ids.map((id, i) => ({ id, i })).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const out = Array.from({ length: n }, () => 0);
  for (let pos = 0; pos < n; pos++) {
    const cur = order[pos].id;
    const prev = pos > 0 ? order[pos - 1].id : "";
    const next = pos < n - 1 ? order[pos + 1].id : "";
    const len = Math.min(
      cur.length,
      Math.max(commonPrefixLength(cur, prev), commonPrefixLength(cur, next)) + 1,
    );
    out[order[pos].i] = Math.max(1, len);
  }
  return out;
}

/** Render an id with its unique leading portion in cyan, the rest dimmed. */
export function highlightId(id: string, uniqueLen: number): string {
  if (uniqueLen <= 0) return id;
  if (uniqueLen >= id.length) return cyan(id);
  return cyan(id.slice(0, uniqueLen)) + dim(id.slice(uniqueLen));
}

/** Highlight each id in a set by its minimal unique prefix. */
export function highlightIds(ids: string[]): string[] {
  const lens = uniquePrefixLengths(ids);
  return ids.map((id, i) => highlightId(id, lens[i]));
}
