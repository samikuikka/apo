/**
 * Assertion-drawer URL param helpers.
 *
 * The drawer's open state lives in the URL as `?assertion=<value>` so it
 * survives share/reload. The value is **namespaced by check id** to prevent
 * cross-check bleed: assertion ids aren't unique across checks (every
 * `t.judge()` call defaults to id `"judge"`), so a bare `?assertion=judge`
 * would match the judge assertion in *every* check and open all their
 * drawers at once.
 *
 * The value is encoded as `<checkId>::<assertionId>`. Each check only opens
 * its drawer when the prefix is its own id.
 */

const SEPARATOR = "::";

/**
 * Build the URL param value for an assertion belonging to a specific check.
 * Returns `null` when there's nothing to select (closes the drawer).
 */
export function buildAssertionParam(
  checkId: string,
  assertionId: string | undefined,
): string | null {
  if (!assertionId) return null;
  return `${checkId}${SEPARATOR}${assertionId}`;
}

/**
 * Parse the URL param value and return the assertion id only if it belongs to
 * the given `checkId`. Returns `null` for any other check (or a malformed
 * value), so a check never reacts to another check's assertion selection.
 */
export function parseOwnAssertionId(
  paramValue: string | null,
  checkId: string,
): string | null {
  if (!paramValue) return null;
  const sep = paramValue.indexOf(SEPARATOR);
  if (sep === -1) return null;
  const prefix = paramValue.slice(0, sep);
  if (prefix !== checkId) return null;
  const assertionId = paramValue.slice(sep + SEPARATOR.length);
  return assertionId || null;
}
