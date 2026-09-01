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
  type ProjectInvitationSummary,
  createProjectInvitation,
  listProjectInvitations,
  resendProjectInvitation,
  revokeProjectInvitation,
} from "@/lib/project-invitations-api"
import {
  getProject,
  listProjects,
  type ProjectRole,
} from "@/lib/projects-api"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { ConfirmationDialogs } from "./confirmation-dialogs"
import { CopyLinkCallout } from "./copy-link-callout"
import { InviteDialog } from "./invite-dialog"
import { MembersContent } from "./members-content"
import { type Row } from "./members-table"
import { ROLE_RANK } from "./role-order"
import {
  fetchReducer,
  initialFetchState,
  initialInviteState,
  initialMemberActionState,
  inviteReducer,
  memberActionReducer,
} from "./members-state"
import { ProjectPickerToolbar } from "./project-picker-toolbar"

export function ProjectMembersSection() {
  const { data: session } = useSession()
  const [fetchState, dispatch] = useReducer(fetchReducer, initialFetchState)
  const { projects, projectsLoading, permissions, members, invitations, loading, loadError } = fetchState
  const [selectedProjectId, setSelectedProjectId] = useState<string>("")

  // Invite dialog
  const [inviteState, dispatchInvite] = useReducer(inviteReducer, initialInviteState)
  const { show: showInviteDialog, email: inviteEmail, role: inviteRole, inviting, error: inviteError, linkCallout } = inviteState

  // Confirmation dialogs + mutation status
  const [actionState, dispatchAction] = useReducer(
    memberActionReducer,
    initialMemberActionState,
  )
  const { removeTarget, revokeTarget, busy, actionError, resendingId } = actionState

  // members management is admin-scoped. Hide the demo project — it
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
    dispatchAction({ type: "ERROR_CLEAR" })
    try {
      await updateProjectMemberRole(selectedProjectId, member.user_id, newRole)
      await fetchAll()
    } catch (e) {
      dispatchAction({
        type: "ERROR_SET",
        error: e instanceof Error ? e.message : "Failed to update role",
      })
    }
  }

  async function handleResend(invitation: ProjectInvitationSummary) {
    dispatchAction({ type: "RESEND_START", id: invitation.id })
    try {
      const response = await resendProjectInvitation(selectedProjectId, invitation.id)
      dispatchInvite({ type: "SET_LINK_CALLOUT", linkCallout: response.delivery_status === "link_only" ? response : null })
      await fetchAll()
    } catch (e) {
      dispatchAction({
        type: "ERROR_SET",
        error: e instanceof Error ? e.message : "Failed to resend invitation",
      })
    } finally {
      dispatchAction({ type: "RESEND_END" })
    }
  }

  async function handleRemove() {
    if (!removeTarget) return
    dispatchAction({ type: "BUSY_START" })
    try {
      await removeProjectMember(selectedProjectId, removeTarget.user_id)
      dispatchAction({ type: "REMOVE_TARGET_CLEAR" })
      await fetchAll()
    } catch (e) {
      dispatchAction({
        type: "ERROR_SET",
        error: e instanceof Error ? e.message : "Failed to remove member",
      })
    } finally {
      dispatchAction({ type: "BUSY_END" })
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return
    dispatchAction({ type: "BUSY_START" })
    try {
      await revokeProjectInvitation(selectedProjectId, revokeTarget.id)
      dispatchAction({ type: "REVOKE_TARGET_CLEAR" })
      await fetchAll()
    } catch (e) {
      dispatchAction({
        type: "ERROR_SET",
        error: e instanceof Error ? e.message : "Failed to revoke invitation",
      })
    } finally {
      dispatchAction({ type: "BUSY_END" })
    }
  }

  const canManage = permissions?.can_manage_members === true
  const currentUserId = session?.user?.id
  const currentProject = projects.find((p) => p.id === selectedProjectId)

  const rows: Row[] = [
    ...members
      .toSorted((a, b) => {
        if (ROLE_RANK[a.role] !== ROLE_RANK[b.role]) return ROLE_RANK[a.role] - ROLE_RANK[b.role]
        return a.email.localeCompare(b.email)
      })
      .map((m): Row => ({ kind: "member", member: m })),
    ...invitations
      .toSorted((a, b) => a.email.localeCompare(b.email))
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
        onRemove={(member) => dispatchAction({ type: "REMOVE_TARGET_SET", member })}
        onResend={handleResend}
        onRevoke={(invitation) => dispatchAction({ type: "REVOKE_TARGET_SET", invitation })}
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
        onCloseRemove={() => dispatchAction({ type: "REMOVE_TARGET_CLEAR" })}
        onConfirmRemove={handleRemove}
        onCloseRevoke={() => dispatchAction({ type: "REVOKE_TARGET_CLEAR" })}
        onConfirmRevoke={handleRevoke}
      />
    </div>
  )
}
