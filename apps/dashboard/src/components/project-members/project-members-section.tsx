"use client"

import { useCallback, useEffect, useReducer, useState } from "react"
import { useSession } from "next-auth/react"
import {
  listProjectMembers,
  removeProjectMember,
  updateProjectMemberRole,
  type ProjectMemberSummary,
} from "@/lib/project-members-api"
import {
  type CreateProjectInvitationResponse,
  type ProjectInvitationSummary,
  createProjectInvitation,
  listProjectInvitations,
  resendProjectInvitation,
  revokeProjectInvitation,
} from "@/lib/project-invitations-api"
import {
  getProject,
  listProjects,
  type Project,
  type ProjectPermissionSummary,
  type ProjectRole,
} from "@/lib/projects-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Check,
  ChevronDown,
  Clock,
  Copy,
  CrownIcon,
  Loader2,
  MailCheck,
  MailWarning,
  MoreHorizontal,
  PlusIcon,
  ShieldCheckIcon,
} from "lucide-react"

type Row =
  | { kind: "member"; member: ProjectMemberSummary }
  | { kind: "invitation"; invitation: ProjectInvitationSummary }

const ROLE_RANK: Record<ProjectRole, number> = { owner: 0, admin: 1, member: 2 }

function initialOf(text: string): string {
  const c = text.trim().charAt(0)
  return c ? c.toUpperCase() : "?"
}

function Avatar({ text }: { text: string }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
      {initialOf(text)}
    </span>
  )
}

function RoleBadge({ role }: { role: ProjectRole }) {
  if (role === "owner") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
        <CrownIcon className="size-3" />
        Owner
      </span>
    )
  }
  if (role === "admin") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        <ShieldCheckIcon className="size-3" />
        Admin
      </span>
    )
  }
  return <span className="px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Member</span>
}

function relativeExpiry(expiresAt: string): string {
  const diffMs = new Date(expiresAt).getTime() - Date.now()
  if (diffMs <= 0) return "expired"
  const hours = Math.round(diffMs / (1000 * 60 * 60))
  if (hours < 1) return "expires <1h"
  if (hours < 24) return `expires in ${hours}h`
  return `expires in ${Math.round(hours / 24)}d`
}

function CopyLinkCallout({
  response,
  onClose,
}: {
  response: CreateProjectInvitationResponse
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const url = response.invite_url

  async function handleCopy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard may be unavailable; the user can still select + copy
    }
  }

  return (
    <div className="mt-2 border border-border bg-muted/40 p-2.5">
      <div className="mb-2 flex items-start gap-2 text-xs text-muted-foreground">
        <MailWarning className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Email delivery isn&rsquo;t configured. Copy this link and send it to{" "}
          <span className="font-medium text-foreground">{response.invitation.email}</span>.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={url ?? ""}
          className="h-8 bg-card font-mono text-[11px]"
          onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.select()}
          aria-label="Invitation link"
        />
        <Button type="button" size="sm" variant="outline" onClick={handleCopy} className="h-8">
          {copied ? <MailCheck className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} className="h-8">
          Dismiss
        </Button>
      </div>
    </div>
  )
}

function MembersTable({
  rows,
  canManage,
  currentUserId,
  ownerCount,
  resendingId,
  onChangeRole,
  onRemove,
  onResend,
  onRevoke,
}: {
  rows: Row[]
  canManage: boolean
  currentUserId: string | undefined
  ownerCount: number
  resendingId: string | null
  onChangeRole: (member: ProjectMemberSummary, newRole: ProjectRole) => void
  onRemove: (member: ProjectMemberSummary) => void
  onResend: (invitation: ProjectInvitationSummary) => void
  onRevoke: (invitation: ProjectInvitationSummary) => void
}) {
  return (
    <div className="border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/20 text-left text-muted-foreground">
            <th className="px-3 py-2 font-medium">Member</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.kind === "member") {
              const m = row.member
              const isSelf = m.user_id === currentUserId
              const isOnlyOwner = m.role === "owner" && ownerCount <= 1
              const roleEditable = canManage && !isSelf
              return (
                <tr key={`m-${m.user_id}`} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <Avatar text={m.name || m.email} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{m.name || m.email}</span>
                          {isSelf && (
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              you
                            </span>
                          )}
                        </div>
                        {m.name && (
                          <div className="truncate text-muted-foreground">{m.email}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {roleEditable ? (
                      <Select
                        value={m.role}
                        onValueChange={(v) => onChangeRole(m, v as ProjectRole)}
                      >
                        <SelectTrigger className="h-7 w-28 text-[11px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="owner">Owner</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {m.is_active ? (
                      <span className="text-success">Active</span>
                    ) : (
                      <span className="text-muted-foreground">Inactive</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canManage && !isSelf && !isOnlyOwner && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="ml-auto flex size-6 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                            aria-label={`Actions for ${m.name || m.email}`}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => onRemove(m)}
                            className="text-destructive"
                          >
                            Remove from project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              )
            }

            const inv = row.invitation
            return (
              <tr key={`i-${inv.id}`} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <Avatar text={inv.email} />
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">{inv.email}</span>
                      <div className="text-muted-foreground">Pending invite</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <RoleBadge role={inv.role} />
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Clock className="size-3" />
                    {resendingId === inv.id ? "sending…" : relativeExpiry(inv.expires_at)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="ml-auto flex size-6 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                          aria-label={`Actions for invitation to ${inv.email}`}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => onResend(inv)}
                          disabled={resendingId === inv.id}
                        >
                          Resend invite
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onRevoke(inv)}
                          className="text-destructive"
                        >
                          Revoke invite
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function InviteDialog({
  open,
  onOpenChange,
  inviteEmail,
  onInviteEmailChange,
  inviteRole,
  onInviteRoleChange,
  inviteError,
  inviting,
  onInvite,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  inviteEmail: string
  onInviteEmailChange: (value: string) => void
  inviteRole: "admin" | "member"
  onInviteRoleChange: (role: "admin" | "member") => void
  inviteError: string | null
  inviting: boolean
  onInvite: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            We&rsquo;ll email them an invitation — or, if email isn&rsquo;t set
            up, give you a link to share. They can join even without an account.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="invite-email" className="mb-1 block text-xs text-muted-foreground">
              Email
            </label>
            <Input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onInviteEmailChange(e.target.value)}
              className="h-9"
              placeholder="teammate@example.com"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="invite-role" className="mb-1 block text-xs text-muted-foreground">
              Role
            </label>
            <Select
              value={inviteRole}
              onValueChange={(v) => onInviteRoleChange(v as "admin" | "member")}
            >
              <SelectTrigger id="invite-role" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onInvite}
            disabled={inviting || !inviteEmail.trim()}
          >
            {inviting ? "Sending…" : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProjectPickerToolbar({
  projects,
  selectedProjectId,
  currentProjectName,
  canManage,
  onSelectProject,
  onInvite,
}: {
  projects: Project[]
  selectedProjectId: string
  currentProjectName: string
  canManage: boolean
  onSelectProject: (id: string) => void
  onInvite: () => void
}) {
  if (projects.length <= 1 && !canManage) return null
  return (
    <div className="flex items-center justify-between gap-3">
      {projects.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 px-1 py-1 text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
            >
              {currentProjectName}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            {projects.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => onSelectProject(p.id)}
                className="justify-between"
              >
                {p.name}
                {p.id === selectedProjectId && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div />
      )}
      {canManage && (
        <Button
          type="button"
          size="sm"
          onClick={onInvite}
        >
          <PlusIcon className="size-3.5" />
          Invite member
        </Button>
      )}
    </div>
  )
}

function ConfirmationDialogs({
  removeTarget,
  revokeTarget,
  busy,
  onCloseRemove,
  onConfirmRemove,
  onCloseRevoke,
  onConfirmRevoke,
}: {
  removeTarget: ProjectMemberSummary | null
  revokeTarget: ProjectInvitationSummary | null
  busy: boolean
  onCloseRemove: () => void
  onConfirmRemove: () => void
  onCloseRevoke: () => void
  onConfirmRevoke: () => void
}) {
  return (
    <>
      {/* Remove confirmation */}
      <Dialog open={!!removeTarget} onOpenChange={(o) => !o && onCloseRemove()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove member</DialogTitle>
            <DialogDescription>
              Remove{" "}
              <span className="font-medium text-foreground">
                {removeTarget?.name || removeTarget?.email}
              </span>{" "}
              from this project? They lose access immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCloseRemove}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirmRemove} disabled={busy}>
              {busy ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog open={!!revokeTarget} onOpenChange={(o) => !o && onCloseRevoke()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Revoke invitation</DialogTitle>
            <DialogDescription>
              Revoke the invitation to{" "}
              <span className="font-medium text-foreground">{revokeTarget?.email}</span>? They
              won&rsquo;t be able to accept it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCloseRevoke}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirmRevoke} disabled={busy}>
              {busy ? "Revoking…" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function MembersContent({
  loading,
  canManage,
  rows,
  currentUserId,
  ownerCount,
  resendingId,
  onChangeRole,
  onRemove,
  onResend,
  onRevoke,
}: {
  loading: boolean
  canManage: boolean
  rows: Row[]
  currentUserId: string | undefined
  ownerCount: number
  resendingId: string | null
  onChangeRole: (member: ProjectMemberSummary, newRole: ProjectRole) => void
  onRemove: (member: ProjectMemberSummary) => void
  onResend: (invitation: ProjectInvitationSummary) => void
  onRevoke: (invitation: ProjectInvitationSummary) => void
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!canManage) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        <ShieldCheckIcon className="mx-auto mb-2 size-4 text-muted-foreground" />
        You need admin or owner access to manage members.
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No members yet. Invite someone with the box above.
      </div>
    )
  }
  return (
    <MembersTable
      rows={rows}
      canManage={canManage}
      currentUserId={currentUserId}
      ownerCount={ownerCount}
      resendingId={resendingId}
      onChangeRole={onChangeRole}
      onRemove={onRemove}
      onResend={onResend}
      onRevoke={onRevoke}
    />
  )
}

// ----------------------------------------------------------------------------
// Fetch-data reducer for ProjectMembersSection.
//
// Consolidates the related server data slices (projects list, and the
// per-project members/invitations/permissions fetch) into one reducer. The
// dialog/confirmation UI state below stays as independent useStates because
// those are unrelated to data fetching.
// ----------------------------------------------------------------------------

interface FetchState {
  projects: Project[]
  projectsLoading: boolean
  permissions: ProjectPermissionSummary | null
  members: ProjectMemberSummary[]
  invitations: ProjectInvitationSummary[]
  loading: boolean
  loadError: string | null
}

type FetchAction =
  | { type: "PROJECTS_LOADED"; projects: Project[] }
  | { type: "FETCH_START" }
  | {
      type: "FETCH_LOADED"
      permissions: ProjectPermissionSummary | null
      members: ProjectMemberSummary[]
      invitations: ProjectInvitationSummary[]
    }
  | { type: "FETCH_ERROR"; error: string }

const initialFetchState: FetchState = {
  projects: [],
  projectsLoading: true,
  permissions: null,
  members: [],
  invitations: [],
  loading: false,
  loadError: null,
}

function fetchReducer(state: FetchState, action: FetchAction): FetchState {
  switch (action.type) {
    case "PROJECTS_LOADED":
      return { ...state, projects: action.projects, projectsLoading: false }
    case "FETCH_START":
      return { ...state, loading: true, loadError: null }
    case "FETCH_LOADED":
      return {
        ...state,
        permissions: action.permissions,
        members: action.members,
        invitations: action.invitations,
        loading: false,
        loadError: null,
      }
    case "FETCH_ERROR":
      return {
        ...state,
        members: [],
        invitations: [],
        permissions: null,
        loading: false,
        loadError: action.error,
      }
    default:
      return state
  }
}

interface InviteState {
  show: boolean;
  email: string;
  role: "admin" | "member";
  inviting: boolean;
  error: string | null;
  linkCallout: CreateProjectInvitationResponse | null;
}

const initialInviteState: InviteState = {
  show: false,
  email: "",
  role: "member",
  inviting: false,
  error: null,
  linkCallout: null,
};

type InviteAction =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "SET_EMAIL"; email: string }
  | { type: "SET_ROLE"; role: "admin" | "member" }
  | { type: "INVITE_START" }
  | { type: "INVITE_SUCCESS"; linkCallout: CreateProjectInvitationResponse | null }
  | { type: "INVITE_ERROR"; error: string }
  | { type: "SET_LINK_CALLOUT"; linkCallout: CreateProjectInvitationResponse | null }
  | { type: "CLEAR_ERROR" };

function inviteReducer(state: InviteState, action: InviteAction): InviteState {
  switch (action.type) {
    case "OPEN":
      return { ...state, show: true, error: null };
    case "CLOSE":
      return { ...state, show: false, email: "", role: "member" };
    case "SET_EMAIL":
      return { ...state, email: action.email };
    case "SET_ROLE":
      return { ...state, role: action.role };
    case "INVITE_START":
      return { ...state, inviting: true, error: null };
    case "INVITE_SUCCESS":
      return {
        ...state,
        inviting: false,
        show: false,
        email: "",
        role: "member",
        linkCallout: action.linkCallout,
      };
    case "INVITE_ERROR":
      return { ...state, inviting: false, error: action.error };
    case "SET_LINK_CALLOUT":
      return { ...state, linkCallout: action.linkCallout };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    default:
      return state;
  }
}

export function ProjectMembersSection() {
  const { data: session } = useSession()
  const [fetchState, dispatch] = useReducer(fetchReducer, initialFetchState)
  const { projects, projectsLoading, permissions, members, invitations, loading, loadError } = fetchState
  const [selectedProjectId, setSelectedProjectId] = useState<string>("")

  // Invite dialog
  const [inviteState, dispatchInvite] = useReducer(inviteReducer, initialInviteState)
  const { show: showInviteDialog, email: inviteEmail, role: inviteRole, inviting, error: inviteError, linkCallout } = inviteState

  // Confirmations
  const [removeTarget, setRemoveTarget] = useState<ProjectMemberSummary | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ProjectInvitationSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [resendingId, setResendingId] = useState<string | null>(null)

  // SPEC-122: members management is admin-scoped. Hide the demo project — it
  // has no memberships.
  useEffect(() => {
    listProjects()
      .then((ps) => {
        const selectable = ps.filter((p) => p.id !== "demo")
        dispatch({ type: "PROJECTS_LOADED", projects: selectable })
        setSelectedProjectId((prev) => prev || (selectable[0]?.id ?? ""))
      })
      .catch(() => {
        dispatch({ type: "PROJECTS_LOADED", projects: [] })
      })
  }, [])

  const fetchAll = useCallback(async () => {
    if (!selectedProjectId) return
    dispatch({ type: "FETCH_START" })
    try {
      const [detail, memberList, inviteList] = await Promise.all([
        getProject(selectedProjectId),
        listProjectMembers(selectedProjectId),
        listProjectInvitations(selectedProjectId),
      ])
      dispatch({
        type: "FETCH_LOADED",
        permissions: detail.permissions ?? null,
        members: memberList,
        invitations: inviteList,
      })
    } catch (e) {
      dispatch({
        type: "FETCH_ERROR",
        error: e instanceof Error ? e.message : "Failed to load members",
      })
    }
  }, [selectedProjectId])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  async function handleInvite() {
    dispatchInvite({ type: "INVITE_START" })
    try {
      const response = await createProjectInvitation(selectedProjectId, {
        email: inviteEmail.trim(),
        role: inviteRole,
      })
      dispatchInvite({
        type: "INVITE_SUCCESS",
        linkCallout: response.delivery_status === "link_only" ? response : null,
      })
      await fetchAll()
    } catch (e) {
      dispatchInvite({ type: "INVITE_ERROR", error: e instanceof Error ? e.message : "Failed to send invitation" })
    }
  }

  async function handleChangeRole(member: ProjectMemberSummary, newRole: ProjectRole) {
    setActionError(null)
    try {
      await updateProjectMemberRole(selectedProjectId, member.user_id, newRole)
      await fetchAll()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to update role")
    }
  }

  async function handleResend(invitation: ProjectInvitationSummary) {
    setResendingId(invitation.id)
    setActionError(null)
    try {
      const response = await resendProjectInvitation(selectedProjectId, invitation.id)
      dispatchInvite({ type: "SET_LINK_CALLOUT", linkCallout: response.delivery_status === "link_only" ? response : null })
      await fetchAll()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to resend invitation")
    } finally {
      setResendingId(null)
    }
  }

  async function handleRemove() {
    if (!removeTarget) return
    setBusy(true)
    setActionError(null)
    try {
      await removeProjectMember(selectedProjectId, removeTarget.user_id)
      setRemoveTarget(null)
      await fetchAll()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to remove member")
    } finally {
      setBusy(false)
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return
    setBusy(true)
    setActionError(null)
    try {
      await revokeProjectInvitation(selectedProjectId, revokeTarget.id)
      setRevokeTarget(null)
      await fetchAll()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to revoke invitation")
    } finally {
      setBusy(false)
    }
  }

  const canManage = permissions?.can_manage_members === true
  const currentUserId = session?.user?.id
  const currentProject = projects.find((p) => p.id === selectedProjectId)

  const rows: Row[] = [
    ...[...members]
      .sort((a, b) => {
        if (ROLE_RANK[a.role] !== ROLE_RANK[b.role]) return ROLE_RANK[a.role] - ROLE_RANK[b.role]
        return a.email.localeCompare(b.email)
      })
      .map((m): Row => ({ kind: "member", member: m })),
    ...[...invitations]
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((i): Row => ({ kind: "invitation", invitation: i })),
  ]

  const ownerCount = members.filter((m) => m.role === "owner").length

  if (projectsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        You don&rsquo;t have any projects yet.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <ProjectPickerToolbar
        projects={projects}
        selectedProjectId={selectedProjectId}
        currentProjectName={currentProject?.name ?? selectedProjectId}
        canManage={canManage}
        onSelectProject={setSelectedProjectId}
        onInvite={() => dispatchInvite({ type: "OPEN" })}
      />

      {linkCallout && (
        <CopyLinkCallout response={linkCallout} onClose={() => dispatchInvite({ type: "SET_LINK_CALLOUT", linkCallout: null })} />
      )}

      {actionError && <p className="text-xs text-destructive">{actionError}</p>}
      {loadError && (
        <div className="flex items-center justify-between py-3 text-xs text-destructive">
          <span>{loadError}</span>
          <Button type="button" variant="ghost" size="xs" onClick={fetchAll}>
            Retry
          </Button>
        </div>
      )}

      <MembersContent
        loading={loading}
        canManage={canManage}
        rows={rows}
        currentUserId={currentUserId}
        ownerCount={ownerCount}
        resendingId={resendingId}
        onChangeRole={handleChangeRole}
        onRemove={setRemoveTarget}
        onResend={handleResend}
        onRevoke={setRevokeTarget}
      />

      {/* Invite dialog */}
      <InviteDialog
        open={showInviteDialog}
        onOpenChange={(o) => dispatchInvite(o ? { type: "OPEN" } : { type: "CLOSE" })}
        inviteEmail={inviteEmail}
        onInviteEmailChange={(email) => dispatchInvite({ type: "SET_EMAIL", email })}
        inviteRole={inviteRole}
        onInviteRoleChange={(role) => dispatchInvite({ type: "SET_ROLE", role })}
        inviteError={inviteError}
        inviting={inviting}
        onInvite={handleInvite}
      />

      <ConfirmationDialogs
        removeTarget={removeTarget}
        revokeTarget={revokeTarget}
        busy={busy}
        onCloseRemove={() => setRemoveTarget(null)}
        onConfirmRemove={handleRemove}
        onCloseRevoke={() => setRevokeTarget(null)}
        onConfirmRevoke={handleRevoke}
      />
    </div>
  )
}
