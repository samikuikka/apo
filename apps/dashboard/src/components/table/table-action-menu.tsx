"use client";

import { Trash2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import type { TableActionMenuProps } from "./types";

/**
 * Dropdown menu for bulk table actions
 *
 * Features:
 * - Shows action count badge
 * - Default icons for action types (delete, export)
 * - Support for custom icons
 * - Destructive action styling
 */
function getDefaultIcon(type: string) {
  switch (type) {
    case "delete":
      return <Trash2 className="mr-2 h-4 w-4" />;
    case "export":
      return <Download className="mr-2 h-4 w-4" />;
    default:
      return null;
  }
}

export function TableActionMenu({
  actions,
  selectedCount,
  disabled = false,
  onActionSelect,
}: TableActionMenuProps) {

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" disabled={disabled || selectedCount === 0}>
          Actions
          <ChevronDown className="ml-2 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onClick={() => onActionSelect(action)}
            className={action.isDestructive ? "text-destructive" : ""}
          >
            {action.icon || getDefaultIcon(action.type)}
            <span>{action.label}</span>
            {selectedCount > 0 && (
              <span className="ml-auto text-muted-foreground">
                ({selectedCount})
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
