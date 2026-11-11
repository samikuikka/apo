"use client"

import { useCallback, useEffect, useReducer, useState } from "react"
import { Check, Copy, Loader2, MailPlus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ErrorBanner } from "@/components/ui/error-banner"
import { Input } from "@/components/ui/input"
import {
  createHostedAccessInvitation,
  listHostedAccessInvitations,
  resendHostedAccessInvitation,
  revokeHostedAccessInvitation,
  type CreateHostedAccessInvitationResponse,
  type HostedAccessInvitationSummary,
} from "@/lib/hosted-access-api"
import { isApiError } from "@/lib/api-error"

type Invitation = HostedAccessInvitationSummary & {
  // The raw invite URL is surfaced exactly once per create/resend when
  // email delivery is unavailable; never stored beyond this view.
  oneTimeUrl?: string
}

type AdminState = {
  invitations: Invitation[]
  loading: boolean
  error: string | null
}

type AdminAction =
  | { type: "LOAD_START" }
  | { type: "LOAD_SUCCESS"; invitations: Invitation[] }
  | { type: "LOAD_ERROR"; message: string }
  | { type: "UPSERT"; invitation: Invitation }
  | { type: "REMOVE"; invitationId: string }

function adminReducer(state: AdminState, action: AdminAction): AdminState {
  switch (action.type) {
    case "LOAD_START":
      return { ...state, loading: true, error: null }
    case "LOAD_SUCCESS":
      return { invitations: action.invitations, loading: false, error: null }
    case "LOAD_ERROR":
      return { ...state, loading: false, error: action.message }
    case "UPSERT": {
      const others = state.invitations.filter(
        (i) => i.id !== action.invitation.id,
      )
      return { ...state, invitations: [action.invitation, ...others] }
    }
    case "REMOVE":
      return {
        ...state,
        invitations: state.invitations.map((i) =>
          i.id === action.invitationId
            ? {
                ...i,
                revoked_at: i.revoked_at ?? new Date().toISOString(),
                oneTimeUrl: undefined,
              }
            : i,
        ),
      }
  }
}

// Locale formatting happens after mount only — the server and first
// client render both show the stable ISO prefix, avoiding hydration
// mismatches (react-doctor no-locale-format-in-render).
function DateTimeText({ value }: { value: string }) {
  const [text, setText] = useState(value)
  useEffect(() => {
    setText(
      new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    )
  }, [value])
  return <span suppressHydrationWarning>{text}</span>
}

function statusOf(invitation: Invitation): {
  label: string
  className: string
} {
  if (invitation.revoked_at)
    return { label: "Revoked", className: "text-muted-foreground" }
  if (invitation.accepted_at)
    return { label: "Accepted", className: "text-success" }
  if (new Date(invitation.expires_at) < new Date())
    return { label: "Expired", className: "text-warning" }
  if (invitation.delivery_method === "failed")
    return { label: "Delivery failed", className: "text-destructive" }
  return { label: "Pending", className: "text-foreground" }
}

function InviteLinkReveal({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true)
        toast.success("Invitation link copied")
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => toast.error("Copy failed — select the link manually"))
  }, [url])

  return (
    <div className="mt-2 border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        Email delivery is not configured. Share this one-time link — it will
        not be shown again:
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {url}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5"
          onClick={handleCopy}
          aria-label="Copy invitation link"
        >
          {copied ? (
            <Check className="size-3.5 text-success" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

export function HostedAccessAdmin({
  initialInvitations,
}: {
  initialInvitations: HostedAccessInvitationSummary[] | null
}) {
  const [state, dispatch] = useReducer(adminReducer, {
    invitations: initialInvitations ?? [],
    loading: initialInvitations === null,
    error: null,
  })
  const [email, setEmail] = useState("")
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (initialInvitations !== null) return
    let cancelled = false
    dispatch({ type: "LOAD_START" })
    listHostedAccessInvitations()
      .then((invitations) => {
        if (!cancelled) dispatch({ type: "LOAD_SUCCESS", invitations })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "LOAD_ERROR",
            message:
              err instanceof Error ? err.message : "Failed to load invitations",
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [initialInvitations])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      const result = await createHostedAccessInvitation(trimmed)
      applyDelivery(result)
      setEmail("")
      toast.success(
        result.delivery_status === "sent"
          ? "Invitation sent"
          : "Invitation created",
      )
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create invitation",
      )
    } finally {
      setCreating(false)
    }
  }

  function applyDelivery(result: CreateHostedAccessInvitationResponse) {
    dispatch({
      type: "UPSERT",
      invitation: {
        ...result.invitation,
        oneTimeUrl: result.invite_url ?? undefined,
      },
    })
  }

  async function handleResend(invitationId: string) {
    setBusyId(invitationId)
    try {
      const result = await resendHostedAccessInvitation(invitationId)
      applyDelivery(result)
      // A self-serve link is mailed or nothing: there is no copy-link to
      // fall back on, so an unsent one is a failure the admin must see.
      if (result.delivery_status === "failed") {
        toast.error("Invitation email not sent. Check the email transport, then resend")
      } else {
        toast.success("Invitation resent. The previous link no longer works")
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to resend invitation",
      )
    } finally {
      setBusyId(null)
    }
  }

  async function handleRevoke(invitationId: string) {
    setBusyId(invitationId)
    try {
      await revokeHostedAccessInvitation(invitationId)
      dispatch({ type: "REMOVE", invitationId })
      toast.success("Invitation revoked")
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        dispatch({ type: "REMOVE", invitationId })
      }
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke invitation",
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6 px-6 py-6">
      <form onSubmit={handleCreate} className="max-w-2xl space-y-3">
        <label
          htmlFor="invite-email"
          className="text-xs font-semibold text-foreground"
        >
          Invite someone to this apo installation
        </label>
        <div className="flex gap-2">
          <Input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            className="h-8 bg-input/30"
          />
          <Button
            type="submit"
            disabled={creating || email.trim().length === 0}
            className="h-8 shrink-0 gap-1.5"
          >
            {creating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <MailPlus className="size-3.5" />
            )}
            Send invitation
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Accepting creates one new Project owned by the invitee. They never
          see your Projects, and you are not added to theirs.
        </p>
      </form>

      <div className="max-w-4xl">
        <h2 className="text-sm font-semibold">Invitations</h2>
        {state.loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading invitations…
          </div>
        ) : state.error ? (
          <ErrorBanner className="mt-2">{state.error}</ErrorBanner>
        ) : state.invitations.length === 0 ? (
          <p className="py-6 text-xs text-muted-foreground">
            No invitations yet. Invite someone above to grant them access to
            this installation.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {state.invitations.map((invitation) => {
              const status = statusOf(invitation)
              const isActive =
                !invitation.accepted_at && !invitation.revoked_at
              return (
                <li
                  key={invitation.id}
                  className="border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {invitation.email}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {invitation.origin === "self_serve" ? "Requested" : "Invited"}{" "}
                        <DateTimeText value={invitation.created_at} /> ·{" "}
                        Expires <DateTimeText value={invitation.expires_at} /> ·{" "}
                        <span className={status.className}>{status.label}</span>
                        {invitation.accepted_at && (
                          <>
                            {" "}
                            · Project{" "}
                            <code className="font-mono text-xs">
                              {invitation.accepted_project_id}
                            </code>
                          </>
                        )}
                      </p>
                    </div>
                    {isActive && (
                      <div className="flex shrink-0 gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5"
                          disabled={busyId === invitation.id}
                          onClick={() => void handleResend(invitation.id)}
                        >
                          {busyId === invitation.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3.5" />
                          )}
                          Resend
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5 text-destructive"
                          disabled={busyId === invitation.id}
                          onClick={() => void handleRevoke(invitation.id)}
                        >
                          <Trash2 className="size-3.5" />
                          Revoke
                        </Button>
                      </div>
                    )}
                  </div>
                  {invitation.oneTimeUrl && (
                    <InviteLinkReveal url={invitation.oneTimeUrl} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
