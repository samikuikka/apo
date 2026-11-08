"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { UserSummary } from "@/lib/users-api"

/**
 * Confirms locking an account. The copy states the no-purge policy: the
 * account loses access at once, while everything it owns is kept.
 */
export function DeactivateUserDialog({
  user,
  busy,
  onClose,
  onConfirm,
}: {
  user: UserSummary | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Deactivate user</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{user?.email}</span>{" "}
            is signed out everywhere, and their API keys stop working
            immediately. Their projects and data are kept. Only project owners
            can delete projects.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? "Deactivating…" : "Deactivate user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
