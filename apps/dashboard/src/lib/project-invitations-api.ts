import { apiClient } from "./api-client";
import { backendFetch } from "./backend-fetch";
import type { ProjectRole } from "./projects-api";

export interface ProjectInvitationSummary {
  id: string;
  email: string;
  role: ProjectRole;
  delivery_method: "email" | "link_only";
  created_at: string;
  expires_at: string;
  invited_by_user_id: string;
  invited_by_name: string | null;
  can_resend: boolean;
  can_revoke: boolean;
}

export interface CreateProjectInvitationRequest {
  email: string;
  role: "admin" | "member" | "owner";
}

export interface CreateProjectInvitationResponse {
  invitation: ProjectInvitationSummary;
  /** Present only when the inviter must share the link out-of-band. */
  invite_url: string | null;
  delivery_status: "sent" | "link_only";
}

export interface InvitationTokenPreview {
  valid: boolean;
  reason: string | null;
  email: string | null;
  project_id: string | null;
  project_name: string | null;
  role: ProjectRole | null;
  requires_login: boolean;
  requires_account_creation: boolean;
}

const NO_CACHE = { cache: "no-store" } as const;

export const listProjectInvitations = (
  projectId: string,
): Promise<ProjectInvitationSummary[]> =>
  apiClient(`/v1/projects/${projectId}/invitations`, NO_CACHE);

export const createProjectInvitation = (
  projectId: string,
  body: CreateProjectInvitationRequest,
): Promise<CreateProjectInvitationResponse> =>
  apiClient(`/v1/projects/${projectId}/invitations`, {
    ...NO_CACHE,
    method: "POST",
    body,
  });

export const resendProjectInvitation = (
  projectId: string,
  invitationId: string,
): Promise<CreateProjectInvitationResponse> =>
  apiClient(
    `/v1/projects/${projectId}/invitations/${invitationId}/resend`,
    { ...NO_CACHE, method: "POST" },
  );

export const revokeProjectInvitation = (
  projectId: string,
  invitationId: string,
): Promise<void> =>
  apiClient(`/v1/projects/${projectId}/invitations/${invitationId}`, {
    ...NO_CACHE,
    method: "DELETE",
  });

export const acceptInvitationExistingAccount = (
  token: string,
): Promise<{ status: string; project_id: string }> =>
  apiClient(`/auth/invitations/accept/existing-account`, {
    ...NO_CACHE,
    method: "POST",
    body: { token },
  });

export interface AcceptInvitationCreateAccountRequest {
  token: string;
  name: string;
  password: string;
}

// Public pre-auth endpoints run before the user has a session cookie.
// backendFetch handles this correctly: in the browser it goes relative
// (/backend-proxy), and no session cookie is simply forwarded as absent.

export async function previewInvitationToken(
  token: string,
): Promise<InvitationTokenPreview> {
  const res = await backendFetch(
    `/auth/invitations/preview?token=${encodeURIComponent(token)}`,
    { cache: "no-store" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(
      typeof body?.detail === "string" && body.detail.trim()
        ? body.detail
        : `Failed to preview invitation: ${res.status}`,
    );
  }
  return res.json();
}

export async function acceptInvitationCreateAccount(
  body: AcceptInvitationCreateAccountRequest,
): Promise<{ status: string; project_id: string }> {
  const res = await backendFetch("/auth/invitations/accept/create-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const respBody = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(
      typeof respBody?.detail === "string" && respBody.detail.trim()
        ? respBody.detail
        : `Failed to accept invitation: ${res.status}`,
    );
  }
  return res.json();
}
