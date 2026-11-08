"use client"

import { useEffect, useReducer, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { ErrorBanner } from "@/components/ui/error-banner"
import {
  deactivateUser,
  listUsers,
  updateUser,
  type UserSummary,
} from "@/lib/users-api"
import { DeactivateUserDialog } from "./deactivate-user-dialog"
import { UsersTable, type PendingActions, type UserAction } from "./users-table"

type UsersState = {
  users: UserSummary[]
  loading: boolean
  error: string | null
}

type UsersStateAction =
  | { type: "LOAD_START" }
  | { type: "LOAD_SUCCESS"; users: UserSummary[] }
  | { type: "LOAD_ERROR"; message: string }
  | { type: "UPSERT"; user: UserSummary }

type ActionMessages = { success: string; failure: string }

/**
 * Installation-admin view of every account. An admin can lock an account,
 * unlock it, or flip its admin flag. There is deliberately no delete:
 * accounts and the data they own are never purged by an admin.
 */
export function UsersAdmin({
  initialUsers,
  currentUserId,
}: {
  initialUsers: UserSummary[] | null
  currentUserId: string
}) {
  const [state, dispatch] = useReducer(usersReducer, {
    users: initialUsers ?? [],
    loading: initialUsers === null,
    error: null,
  })
  const [pending, setPending] = useState<PendingActions>(() => new Map())
  const [deactivateTarget, setDeactivateTarget] = useState<UserSummary | null>(
    null,
  )

  useEffect(() => {
    if (initialUsers !== null) return
    let cancelled = false
    dispatch({ type: "LOAD_START" })
    listUsers()
      .then((users) => {
        if (!cancelled) dispatch({ type: "LOAD_SUCCESS", users })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "LOAD_ERROR",
            message: err instanceof Error ? err.message : "Failed to load users",
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [initialUsers])

  // One runner for every row action: marks the row busy, applies the
  // returned row, and reports the outcome. Backend refusals arrive as
  // ApiError, whose message carries the server's reason.
  async function runUserAction(
    userId: string,
    action: UserAction,
    request: () => Promise<UserSummary>,
    messages: ActionMessages,
  ) {
    setPending((prev) => new Map(prev).set(userId, action))
    try {
      dispatch({ type: "UPSERT", user: await request() })
      toast.success(messages.success)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : messages.failure)
    } finally {
      setPending((prev) => withoutKey(prev, userId))
    }
  }

  async function handleConfirmDeactivate() {
    const target = deactivateTarget
    if (!target) return
    await runUserAction(
      target.id,
      "deactivate",
      async () => {
        // DELETE answers only {ok: true}; the lock is the one field it changes.
        await deactivateUser(target.id)
        return { ...target, is_active: false }
      },
      { success: "User deactivated", failure: "Failed to deactivate user" },
    )
    setDeactivateTarget((current) =>
      current?.id === target.id ? null : current,
    )
  }

  function handleReactivate(user: UserSummary) {
    void runUserAction(
      user.id,
      "reactivate",
      () => updateUser(user.id, { is_active: true }),
      { success: "User reactivated", failure: "Failed to reactivate user" },
    )
  }

  function handleToggleAdmin(user: UserSummary) {
    const grant = !user.is_admin
    void runUserAction(
      user.id,
      "toggle-admin",
      () => updateUser(user.id, { is_admin: grant }),
      grant
        ? { success: "Admin role granted", failure: "Failed to grant admin role" }
        : { success: "Admin role removed", failure: "Failed to remove admin role" },
    )
  }

  return (
    <div className="px-6 py-6">
      <div className="max-w-6xl">
        {state.loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading users…
          </div>
        ) : state.error ? (
          <ErrorBanner>{state.error}</ErrorBanner>
        ) : state.users.length === 0 ? (
          <p className="py-6 text-xs text-muted-foreground">
            No accounts yet. Invite someone from Hosted access.
          </p>
        ) : (
          <UsersTable
            users={state.users}
            currentUserId={currentUserId}
            pending={pending}
            onDeactivate={setDeactivateTarget}
            onReactivate={handleReactivate}
            onToggleAdmin={handleToggleAdmin}
          />
        )}
      </div>
      <DeactivateUserDialog
        user={deactivateTarget}
        busy={
          deactivateTarget !== null &&
          pending.get(deactivateTarget.id) === "deactivate"
        }
        onClose={() => setDeactivateTarget(null)}
        onConfirm={() => void handleConfirmDeactivate()}
      />
    </div>
  )
}

function usersReducer(state: UsersState, action: UsersStateAction): UsersState {
  switch (action.type) {
    case "LOAD_START":
      return { ...state, loading: true, error: null }
    case "LOAD_SUCCESS":
      return { users: action.users, loading: false, error: null }
    case "LOAD_ERROR":
      return { ...state, loading: false, error: action.message }
    case "UPSERT":
      return { ...state, users: upsertInPlace(state.users, action.user) }
  }
}

// Rows keep their server order (oldest first); an update must not make
// the row jump, so it is replaced where it stands.
function upsertInPlace(users: UserSummary[], user: UserSummary): UserSummary[] {
  if (!users.some((u) => u.id === user.id)) return [...users, user]
  return users.map((u) => (u.id === user.id ? user : u))
}

function withoutKey<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(map)
  next.delete(key)
  return next
}
