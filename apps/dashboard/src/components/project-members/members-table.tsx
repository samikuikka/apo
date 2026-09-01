"use client"

import type { ProjectMemberSummary } from "@/lib/project-members-api"
import type { ProjectInvitationSummary } from "@/lib/project-invitations-api"
import type { ProjectRole } from "@/lib/projects-api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Clock,
  CrownIcon,
  MoreHorizontal,
  ShieldCheckIcon,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type Row =
  | { kind: "member"; member: ProjectMemberSummary }
  | { kind: "invitation"; invitation: ProjectInvitationSummary }

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
  if (role === "viewer") {
    return <span className="px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground/70">Viewer</span>
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

export function MembersTable({
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
    <div className="relative overflow-x-auto border border-border">
      <table className="w-full min-w-[420px] text-xs">
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
                          <SelectItem value="viewer">Viewer</SelectItem>
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
