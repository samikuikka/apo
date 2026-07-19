/**
 * Column reordering utilities for dashboard tables.
 *
 * These are pure helpers that operate on TanStack's `ColumnOrderState`
 * (a plain array of column ids). They never touch the DOM and never mutate
 * their inputs, which keeps reordering predictable and testable.
 */

export type ColumnOrderState = string[];

/**
 * Move `columnId` one position in the given direction within `order`.
 *
 * Returns a new array with the column swapped with its neighbour. When the
 * column is unknown or already at the requested edge, the original array is
 * returned unchanged so callers can short-circuit pointless state updates.
 *
 * @example
 * moveColumn(["a", "b", "c"], "b", "left");  // ["b", "a", "c"]
 * moveColumn(["a", "b", "c"], "a", "left");  // ["a", "b", "c"] (already first)
 */
export function moveColumn(
  order: string[],
  columnId: string,
  direction: "left" | "right",
): string[] {
  const currentIndex = order.indexOf(columnId);
  if (currentIndex === -1) return order;

  const swapIndex = direction === "left" ? currentIndex - 1 : currentIndex + 1;
  if (swapIndex < 0 || swapIndex >= order.length) return order;

  const next = [...order];
  [next[currentIndex], next[swapIndex]] = [next[swapIndex], next[currentIndex]];
  return next;
}

/**
 * The three render groups TanStack splits columns into when pinning is active.
 * Reordering is allowed freely *within* a group but must not cross boundaries,
 * which keeps pinning and column-order state cooperating instead of fighting.
 */
export type PinGroup = "left" | "center" | "right";

/**
 * Maps a TanStack pin state (`false | "left" | "right"`) into a `PinGroup`.
 * Unpinned columns land in the `"center"` group.
 */
export function pinGroupOf(pinned: false | "left" | "right"): PinGroup {
  if (pinned === "left") return "left";
  if (pinned === "right") return "right";
  return "center";
}

/**
 * Returns `true` when the column at `index` can move in `direction` without
 * crossing a pinning boundary. `pinGroups` is a parallel array of group labels
 * for the ordered column list (one entry per column, derived via `pinGroupOf`).
 *
 * Moving is blocked when the neighbour index is out of range or belongs to a
 * different pin group, which prevents impossible reorder states while still
 * allowing free reordering inside each pinned/center group.
 *
 * @example
 * const groups: PinGroup[] = ["left", "left", "center", "center"];
 * canMoveWithinPinGroup(groups, 1, "right"); // false (left -> center boundary)
 * canMoveWithinPinGroup(groups, 2, "right"); // true  (center -> center)
 */
export function canMoveWithinPinGroup(
  pinGroups: readonly PinGroup[],
  index: number,
  direction: "left" | "right",
): boolean {
  const target = direction === "left" ? index - 1 : index + 1;
  if (target < 0 || target >= pinGroups.length) return false;
  return pinGroups[target] === pinGroups[index];
}
