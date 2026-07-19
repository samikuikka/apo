import type { CSSProperties } from "react";
import type { Column } from "@tanstack/react-table";

export type PinnedDataAttrs = {
  "data-pinned"?: "left" | "right";
  "data-pinned-edge"?: "last-left" | "first-right";
};

/**
 * Returns the dynamic inline styles needed to stick a pinned column
 * to the left or right edge of the horizontal scroll viewport.
 *
 * The visual layering (background, shadow divider, hover coordination)
 * is handled by `data-pinned` / `data-pinned-edge` attribute selectors
 * baked into `TableHead` and `TableCell`. This helper only computes the
 * position values that depend on sibling column widths.
 */
export function getPinnedColumnStyle<TData>(
  column: Column<TData>,
): CSSProperties {
  const isPinned = column.getIsPinned();
  if (!isPinned) return {};

  if (isPinned === "left") {
    return {
      position: "sticky",
      left: `${column.getStart("left")}px`,
      zIndex: 2,
    };
  }

  return {
    position: "sticky",
    right: `${column.getAfter("right")}px`,
    zIndex: 2,
  };
}

/**
 * Returns the data attributes that trigger the pinned-column styling
 * (solid background, hover/selected coordination, shadow dividers)
 * baked into `TableHead` and `TableCell`.
 *
 * Spread the result onto the cell element alongside `getPinnedColumnStyle`.
 */
export function getPinnedColumnAttrs<TData>(
  column: Column<TData>,
): PinnedDataAttrs {
  const isPinned = column.getIsPinned();
  if (!isPinned) return {};

  const attrs: PinnedDataAttrs = { "data-pinned": isPinned };

  if (isPinned === "left" && column.getIsLastColumn("left")) {
    attrs["data-pinned-edge"] = "last-left";
  } else if (isPinned === "right" && column.getIsFirstColumn("right")) {
    attrs["data-pinned-edge"] = "first-right";
  }

  return attrs;
}
