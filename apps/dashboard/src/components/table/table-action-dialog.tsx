"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle } from "lucide-react";
import { type TableActionDialogProps } from "./types";

/**
 * Dialog component for confirming and executing bulk table actions
 *
 * Features:
 * - Confirmation message with selected count
 * - Destructive action warning
 * - Loading state during execution
 * - Error handling display
 */
export function TableActionDialog({
  isOpen,
  onClose,
  action,
  selectedIds,
  itemName,
  onConfirm,
}: TableActionDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const getItemName = () => {
    return selectedIds.length === 1 ? itemName : `${itemName}s`;
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {action.isDestructive && (
              <AlertTriangle className="h-5 w-5 text-destructive" />
            )}
            {action.label}
          </DialogTitle>
          <DialogDescription>
            {action.confirmMessage ||
              `Are you sure you want to ${action.label.toLowerCase()} ${selectedIds.length} ${getItemName()}?`}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button type="button"
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button type="button"
            variant={action.isDestructive ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={isLoading}
          >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
