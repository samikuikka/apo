"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { UserSummary } from "@/lib/users-api"
import { cn } from "@/lib/utils"

export type UserAction = "deactivate" | "reactivate" | "toggle-admin"

/** The in-flight action per user id. A row with an entry has its buttons disabled. */
export type PendingActions = ReadonlyMap<string, UserAction>

type RowHandlers = {
  onDeactivate: (user: UserSummary) => void
  onReactivate: (user: UserSummary) => void
  onToggleAdmin: (user: UserSummary) => void
}

export function UsersTable({
  users,
  currentUserId,
  pending,
  ...handlers
}: {
  users: UserSummary[]
  currentUserId: string
  pending: PendingActions
} & RowHandlers) {
  return (
    <div className="relative overflow-x-auto border border-border">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/20 text-left text-muted-foreground">
            <th className="px-3 py-2 font-medium">Email</th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-border last:border-0">
              <td className="px-3 py-2 text-foreground">{user.email}</td>
              <td className="px-3 py-2">{user.name}</td>
              <td className="px-3 py-2">
                {user.is_admin ? (
                  <Badge variant="secondary">Admin</Badge>
                ) : (
                  <span className="text-muted-foreground">User</span>
                )}
              </td>
              <td className="px-3 py-2">
                {user.is_active ? (
                  "Active"
                ) : (
                  <span className="text-warning">Deactivated</span>
                )}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                <DateTimeText value={user.created_at} />
              </td>
              <td className="px-3 py-2 text-right">
                {/* No actions on the signed-in admin's own row: locking or
                    demoting yourself would cut off the admin access this
                    page runs on. */}
                {user.id === currentUserId ? (
                  <span className="text-muted-foreground">You</span>
                ) : (
                  <UserRowActions
                    user={user}
                    pendingAction={pending.get(user.id)}
                    {...handlers}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UserRowActions({
  user,
  pendingAction,
  onDeactivate,
  onReactivate,
  onToggleAdmin,
}: { user: UserSummary; pendingAction: UserAction | undefined } & RowHandlers) {
  const disabled = pendingAction !== undefined

  if (!user.is_active) {
    return (
      <RowActionButton
        label="Reactivate"
        email={user.email}
        variant="outline"
        pending={pendingAction === "reactivate"}
        disabled={disabled}
        onClick={() => onReactivate(user)}
      />
    )
  }

  return (
    <div className="flex justify-end gap-1.5">
      <RowActionButton
        label={user.is_admin ? "Remove admin" : "Make admin"}
        email={user.email}
        variant="ghost"
        pending={pendingAction === "toggle-admin"}
        disabled={disabled}
        onClick={() => onToggleAdmin(user)}
      />
      <RowActionButton
        label="Deactivate"
        email={user.email}
        variant="outline"
        className="text-destructive"
        pending={pendingAction === "deactivate"}
        disabled={disabled}
        onClick={() => onDeactivate(user)}
      />
    </div>
  )
}

// Every row repeats the same labels, so the accessible name carries the
// account's email to tell the buttons apart for screen readers.
function RowActionButton({
  label,
  email,
  variant,
  className,
  pending,
  disabled,
  onClick,
}: {
  label: string
  email: string
  variant: "outline" | "ghost"
  className?: string
  pending: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      className={cn("h-8 gap-1.5", className)}
      disabled={disabled}
      aria-label={`${label} ${email}`}
      onClick={onClick}
    >
      {pending && <Loader2 className="size-3.5 animate-spin" />}
      {label}
    </Button>
  )
}

// Locale formatting happens after mount only: the server and first client
// render both show the stable ISO string, avoiding hydration mismatches
// (react-doctor no-locale-format-in-render).
function DateTimeText({ value }: { value: string }) {
  const [text, setText] = useState(value)
  useEffect(() => {
    const date = new Date(value)
    setText(
      Number.isNaN(date.getTime())
        ? value
        : date.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
    )
  }, [value])
  return <span suppressHydrationWarning>{text}</span>
}
