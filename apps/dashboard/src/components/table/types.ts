import { ReactNode } from "react";

/**
 * Bulk action types for table rows
 */
export type TableActionType = "delete" | "export" | "custom";

/**
 * Definition of a bulk action that can be performed on selected table rows
 */
export interface TableAction {
  /** Unique identifier for this action */
  id: string;
  /** Display label for the action */
  label: string;
  /** Type of action (determines default icon and behavior) */
  type: TableActionType;
  /** Optional custom icon (overrides default) */
  icon?: ReactNode;
  /** Confirmation message to show before executing */
  confirmMessage?: string;
  /** Whether this action is destructive (shows warning styles) */
  isDestructive?: boolean;
}

/**
 * Props for the table action menu component
 */
export interface TableActionMenuProps {
  /** Available actions to display */
  actions: TableAction[];
  /** Number of currently selected rows */
  selectedCount: number;
  /** Whether the menu should be disabled */
  disabled?: boolean;
  /** Callback when an action is selected */
  onActionSelect: (action: TableAction) => void;
}

/**
 * Props for the table action dialog component
 */
export interface TableActionDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** The action being performed */
  action: TableAction;
  /** IDs of selected rows */
  selectedIds: string[];
  /** Display name for the items (e.g., "run", "session") */
  itemName: string;
  /** Callback when action is confirmed */
  onConfirm: () => Promise<void>;
}
