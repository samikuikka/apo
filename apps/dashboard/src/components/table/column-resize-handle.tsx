"use client";

import { type Header } from "@tanstack/react-table";
import { cn } from "@/lib/utils";

export interface ColumnResizeHandleProps<TData> {
  header: Header<TData, unknown>;
}

/**
 * Drag handle rendered at the right edge of a resizable table header.
 *
 * Calls TanStack's `header.getResizeHandler()` and shows active feedback
 * while the user is dragging.
 *
 * Must be rendered inside a `position: relative` container (e.g. TableHead).
 *
 * @example
 * <TableHead style={{ position: "relative" }}>
 *   {flexRender(header.column.columnDef.header, header.getContext())}
 *   {header.column.getCanResize() && (
 *     <ColumnResizeHandle header={header} />
 *   )}
 * </TableHead>
 */
export function ColumnResizeHandle<TData>({
  header,
}: ColumnResizeHandleProps<TData>) {
  const isResizing = header.column.getIsResizing();

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column (double-click or press Enter to reset)"
      tabIndex={0}
      onPointerDown={header.getResizeHandler()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => header.column.resetSize()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          header.column.resetSize();
        }
      }}
      className={cn(
        "absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize touch-none select-none",
        "flex items-center justify-center",
        "transition-colors duration-100",
        isResizing
          ? "bg-primary"
          : "bg-transparent hover:bg-primary/40",
      )}
    >
      <span
        className={cn(
          "pointer-events-none h-full w-[2px] rounded-full",
          isResizing ? "bg-primary opacity-100" : "opacity-0",
        )}
      />
    </span>
  );
}
