import { apiClient } from "./api-client";
import { backendFetch } from "./backend-fetch";

export interface HostedAccessInvitationSummary {
  id: string;
  email: string;
  /** "failed" is self-serve only: that link is never handed to anyone. */
  delivery_method: "email" | "link_only" | "failed";
  expires_at: string;
  created_at: string;
  /** "self_serve" rows were requested by the visitor and have no inviter. */
  origin: "admin" | "self_serve";
  invited_by_user_id: string | null;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  accepted_project_id: string | null;
  revoked_at: string | null;
}

export interface CreateHostedAccessInvitationResponse {
  invitation: HostedAccessInvitationSummary;
  /** Present only when the administrator must share the link out-of-band. */
  invite_url: string | null;
  delivery_status: "sent" | "link_only" | "failed";
}

export type SignupMode = "invite_only" | "self_serve";

export interface AcceptHostedAccessResult {
  status: string;
  project_id: string;
  /** The account's address; the preview only carries a masked one. */
  email: string;
  /** True when the account must enter a mailed code before signing in. */
  email_verification_required: boolean;
}

export interface HostedAccessPreview {
  valid: boolean;
  reason: "invalid" | "expired" | "revoked" | "accepted" | null;
  /** Masked by the server (j***n@example.com); compare with maskEmail. */
  email: string | null;
  requires_login: boolean;
  requires_account_creation: boolean;
}

export interface AcceptHostedAccessCreateAccountRequest {
  token: string;
  name: string;
  password: string;
  project_name: string;
}

const NO_CACHE = { cache: "no-store" } as const;

// Administrator endpoints ride the authenticated browser session —
// never an ADMIN_API_KEY in URLs or client code.
export const listHostedAccessInvitations = (): Promise<
  HostedAccessInvitationSummary[]
> => apiClient("/v1/admin/hosted-access-invitations", NO_CACHE);

export const createHostedAccessInvitation = (
  email: string,
): Promise<CreateHostedAccessInvitationResponse> =>
  apiClient("/v1/admin/hosted-access-invitations", {
    ...NO_CACHE,
    method: "POST",
    body: { email },
  });

export const resendHostedAccessInvitation = (
  invitationId: string,
): Promise<CreateHostedAccessInvitationResponse> =>
  apiClient(
    `/v1/admin/hosted-access-invitations/${invitationId}/resend`,
    { ...NO_CACHE, method: "POST" },
  );

export const revokeHostedAccessInvitation = (
  invitationId: string,
): Promise<void> =>
  apiClient(`/v1/admin/hosted-access-invitations/${invitationId}`, {
    ...NO_CACHE,
    method: "DELETE",
  });

export const acceptHostedAccessExistingAccount = (
  token: string,
  projectName: string,
): Promise<AcceptHostedAccessResult> =>
  apiClient("/auth/hosted-access/accept/existing-account", {
    ...NO_CACHE,
    method: "POST",
    body: { token, project_name: projectName },
  });

// Public pre-admission endpoints run before any session cookie exists.
// backendFetch routes browser calls through /backend-proxy and simply
// forwards an absent session cookie.
export async function previewHostedAccessToken(
  token: string,
  signal?: AbortSignal,
): Promise<HostedAccessPreview> {
  const res = await backendFetch(
    `/auth/hosted-access/preview?token=${encodeURIComponent(token)}`,
    { cache: "no-store", signal },
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

export async function acceptHostedAccessCreateAccount(
  body: AcceptHostedAccessCreateAccountRequest,
): Promise<AcceptHostedAccessResult> {
  const res = await backendFetch("/auth/hosted-access/accept/create-account", {
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

/**
 * Whether this installation takes self-serve invitation requests. Any
 * failure reads as invite_only: the request form must not appear on a
 * guess.
 */
export async function fetchSignupMode(signal?: AbortSignal): Promise<SignupMode> {
  const res = await backendFetch("/auth/hosted-access/mode", {
    cache: "no-store",
    signal,
  });
  if (!res.ok) return "invite_only";
  const body = await res.json().catch(() => null);
  return body?.mode === "self_serve" ? "self_serve" : "invite_only";
}

/**
 * Ask for an invitation for `email`. The accept link is mailed, never
 * returned: the server gives every eligible-looking address the same
 * message, so this cannot tell whether an account already exists.
 */
export async function requestHostedAccessInvitation(
  email: string,
): Promise<{ message: string }> {
  const res = await backendFetch("/auth/hosted-access/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      typeof body?.detail === "string" && body.detail.trim()
        ? body.detail
        : res.status === 422
          ? "Enter a valid email address."
          : `Failed to request an invitation: ${res.status}`,
    );
  }
  return res.json();
}

/**
 * The server's preview mask (mask_email in the backend's hosted access
 * service): first and last character of the local part around "***", or
 * only the first when the local part has one or two characters. Masking
 * the session email the same way is how the join page checks a signed-in
 * user against an invitation whose address it never sees in full.
 */
export function maskEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  const local = at < 0 ? "" : normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  return `${local.slice(0, 1)}***${tail}@${domain}`;
}
