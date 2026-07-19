"use client";

import { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TableAction } from "./types";
import { TableActionMenu } from "./table-action-menu";
import { cn } from "@/lib/utils";

interface TableToolbarProps {
  /** Number of selected rows */
  selectedCount: number;
  /** Display name for the items (e.g., "run", "session") */
  itemName: string;
  /** Available bulk actions */
  actions: TableAction[];
  /** Callback to clear selection */
  onClearSelection: () => void;
  /** Callback when an action is selected */
  onActionSelect: (action: TableAction) => void;
  /** Default toolbar content (filters, search, etc.) */
  children: ReactNode;
}

/**
 * Fixed toolbar component for table headers
 *
 * Features:
 * - Consistent height AND width (prevents ALL layout shifts)
 * - Shows default content (filters, search) when nothing selected
 * - Shows selection state + actions when items selected
 * - Smooth transitions between states with no movement
 *
 * @example
 * <TableToolbar
 *   selectedCount={selectedCount}
 *   itemName="run"
 *   actions={bulkActions}
 *   onClearSelection={() => setRowSelection({})}
 *   onActionSelect={handleActionSelect}
 * >
 *   <div className="flex items-center gap-2">
 *     <SearchInput />
 *     <Filters />
 *   </div>
 * </TableToolbar>
 */
export function TableToolbar({
  selectedCount,
  itemName,
  actions,
  onClearSelection,
  onActionSelect,
  children,
}: TableToolbarProps) {
  const getItemName = () => {
    return selectedCount === 1 ? itemName : `${itemName}s`;
  };

  return (
    <div className="relative border-b bg-background" style={{ minHeight: "60px" }}>
      {/* Default state - always rendered but faded when selected */}
      <div
        className={cn(
          "flex items-center justify-between w-full px-4 py-3 transition-opacity duration-200",
          selectedCount > 0 ? "opacity-0 pointer-events-none" : "opacity-100"
        )}
      >
        {children}
      </div>

      {/* Selection state - always rendered but faded when not selected */}
      <div
        className={cn(
          "flex items-center justify-between w-full px-4 py-3 absolute inset-0 transition-opacity duration-200",
          selectedCount > 0 ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {selectedCount} {getItemName()} selected
          </span>
          <Button type="button"
            variant="ghost"
            size="sm"
            onClick={onClearSelection}
            className="h-7 px-2"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {actions.length > 0 && (
          <TableActionMenu
            actions={actions}
            selectedCount={selectedCount}
            onActionSelect={onActionSelect}
          />
        )}
      </div>
    </div>
  );
}
