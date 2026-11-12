# pyright: reportCallInDefaultInitializer=false, reportUnusedCallResult=false

"""Hosted access invitation routes.

Three explicitly separated route groups on one router:

- **administrator** endpoints under ``/v1/admin/hosted-access-invitations``:
  list, issue, resend, revoke. Guarded by
  ``require_installation_admin`` (browser-session authority only).
- **admission** endpoints under ``/auth/hosted-access``: public token
  preview and new-account acceptance (bearer token authority, added to
  ``AuthMiddleware.PUBLIC_PATHS``), plus existing-account acceptance
  which requires an authenticated session before the route runs.
- **self-serve** endpoints under ``/auth/hosted-access``: the public
  request form and the mode probe the join page reads. Open only while
  ``APO_SIGNUP_MODE=self_serve`` and an email transport is configured.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlmodel import Session, select

from ..auth.client_ip import get_client_ip
from ..auth.rate_limit import LoginRateLimiter
from ..db import get_session
from ..models.db import UserDB
from ..models.schemas import (
    AcceptHostedAccessCreateAccountRequest,
    AcceptHostedAccessExistingAccountRequest,
    AcceptHostedAccessResponse,
    CreateHostedAccessInvitationRequest,
    CreateHostedAccessInvitationResponse,
    HostedAccessInvitationPreview,
    HostedAccessInvitationSummary,
    SelfServeInvitationRequest,
    SelfServeInvitationRequestAccepted,
    SignupModeResponse,
)
from ..services.email import get_email_service
from ..services.hosted_access_invitations import (
    accept_hosted_access_create_account,
    accept_hosted_access_existing_account,
    create_or_refresh_hosted_access_invitation,
    list_hosted_access_invitations,
    preview_hosted_access_invitation,
    request_self_serve_invitation,
    resend_hosted_access_invitation,
    revoke_hosted_access_invitation,
)
from ..services.installation_admin import require_installation_admin
from ..services.invitation_tokens import normalize_email
from ..services.signup_config import SignupConfig, load_signup_config
from .auth import create_and_send_otp

router = APIRouter(tags=["hosted-access"])

# Public admission endpoints are bearer-capability probes; rate-limit
# them per IP like the other pre-authentication endpoints.
hosted_access_rate_limiter = LoginRateLimiter(max_attempts=30, window_seconds=60)

_SELF_SERVE_WINDOW_SECONDS = 3600
# Three per hour per address, matching the per-IP default: a requester who
# rotates addresses still cannot make one inbox the target of a mail flood.
_SELF_SERVE_REQUESTS_PER_HOUR_PER_EMAIL = 3

# The per-IP ceiling comes from APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP and
# is applied on each request, so it tracks the validated configuration.
self_serve_ip_rate_limiter = LoginRateLimiter(
    # Overwritten from APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP on every
    # request (same 3/hour default); this value only shapes the window.
    max_attempts=_SELF_SERVE_REQUESTS_PER_HOUR_PER_EMAIL,
    window_seconds=_SELF_SERVE_WINDOW_SECONDS,
)
self_serve_email_rate_limiter = LoginRateLimiter(
    max_attempts=_SELF_SERVE_REQUESTS_PER_HOUR_PER_EMAIL,
    window_seconds=_SELF_SERVE_WINDOW_SECONDS,
)


def _enforce_public_rate_limit(request: Request) -> None:
    ip = get_client_ip(request)
    if not hosted_access_rate_limiter.is_allowed(ip):
        retry_after = hosted_access_rate_limiter.get_retry_after(ip)
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again later.",
            headers={"Retry-After": str(retry_after)},
        )
    hosted_access_rate_limiter.record_attempt(ip)


# ---------------------------------------------------------------------------
# Administrator endpoints
# ---------------------------------------------------------------------------


@router.get("/v1/admin/hosted-access-invitations")
def list_invitations(
    request: Request,
    session: Session = Depends(get_session),
) -> list[HostedAccessInvitationSummary]:
    """List every hosted access invitation (newest first).

    Includes expired, revoked, and accepted rows for auditing; the
    summary carries acceptance state. Installation Administrator only.
    """
    _ = require_installation_admin(request, session)
    return list_hosted_access_invitations(session)


@router.post(
    "/v1/admin/hosted-access-invitations",
    status_code=201,
)
async def create_invitation(
    body: CreateHostedAccessInvitationRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> CreateHostedAccessInvitationResponse:
    """Invite one person to this apo installation.

    Creates no User, Project, or membership. When email delivery is not
    configured the response carries a one-time ``invite_url`` to share
    out-of-band. Re-inviting the same email rotates the active
    invitation in place.
    """
    admin = require_installation_admin(request, session)
    return await create_or_refresh_hosted_access_invitation(
        session, email=body.email, invited_by_user_id=admin.id
    )


@router.post(
    "/v1/admin/hosted-access-invitations/{invitation_id}/resend",
)
async def resend_invitation(
    invitation_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> CreateHostedAccessInvitationResponse:
    """Rotate an invitation's token and expiry, then re-attempt delivery.

    The previous token stops working immediately.
    """
    _ = require_installation_admin(request, session)
    return await resend_hosted_access_invitation(
        session, invitation_id=invitation_id
    )


@router.delete("/v1/admin/hosted-access-invitations/{invitation_id}", status_code=204)
def revoke_invitation(
    invitation_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> Response:
    """Revoke an invitation. Idempotent; the token stops working immediately."""
    _ = require_installation_admin(request, session)
    revoke_hosted_access_invitation(session, invitation_id=invitation_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Admission endpoints (public bearer token / authenticated session)
# ---------------------------------------------------------------------------


@router.get("/auth/hosted-access/preview")
def preview_invitation(
    request: Request,
    token: str = Query(...),
    session: Session = Depends(get_session),
) -> HostedAccessInvitationPreview:
    """Public preview of an admission token.

    Distinguishes invalid/expired/revoked/accepted without revealing the
    invited email for anything but a valid, active invitation.
    """
    _enforce_public_rate_limit(request)
    return preview_hosted_access_invitation(session, token)


@router.post("/auth/hosted-access/accept/create-account")
async def accept_create_account(
    body: AcceptHostedAccessCreateAccountRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> AcceptHostedAccessResponse:
    """Accept an admission by creating the invited User and their Project.

    The bearer token alone is the authority (no session yet). Atomic:
    User, Project, owner membership, and invitation consumption commit
    together or not at all. Single-use; replays are rejected.

    An account created from a self-serve invitation must verify its email
    before it can sign in: the response says so and a code is mailed.
    """
    _enforce_public_rate_limit(request)
    accepted = accept_hosted_access_create_account(
        session,
        raw_token=body.token,
        name=body.name,
        password=body.password,
        project_name=body.project_name,
    )
    if accepted.email_verification_required:
        user = session.exec(
            select(UserDB).where(UserDB.email == accepted.email)
        ).one()
        await create_and_send_otp(user, session)
    return accepted


@router.post("/auth/hosted-access/accept/existing-account")
async def accept_existing_account(
    body: AcceptHostedAccessExistingAccountRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> AcceptHostedAccessResponse:
    """Accept an admission while signed in as the invited User.

    Requires an authenticated session whose email matches the
    invitation; a mismatch is a 409 that consumes nothing.
    """
    user_id = getattr(request.state, "user_id", None)
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    return accept_hosted_access_existing_account(
        session,
        raw_token=body.token,
        accepting_user_id=user_id,
        project_name=body.project_name,
    )


@router.get("/auth/hosted-access/mode")
def signup_mode() -> SignupModeResponse:
    """Whether this installation takes self-serve invitation requests.

    The join page reads this to decide whether to show the request form.
    """
    config = load_signup_config()
    return SignupModeResponse(
        mode="self_serve" if _self_serve_open(config) else "invite_only"
    )


@router.post("/auth/hosted-access/request", status_code=202)
async def request_invitation(
    body: SelfServeInvitationRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> SelfServeInvitationRequestAccepted:
    """Ask for an invitation to this installation for your own email.

    The accept link is mailed to the address and nowhere else. Every
    eligible-looking address gets the same 202, whether or not an account
    or a pending invitation exists and whether or not the mail went out.
    503 while self-serve signup is off; 429 when the per-IP, per-email, or
    outstanding-invitation limit is reached.
    """
    config = load_signup_config()
    if not _self_serve_open(config):
        raise HTTPException(
            status_code=503, detail="Self-serve signup is not available."
        )
    _enforce_self_serve_rate_limits(request, body.email, config)
    await request_self_serve_invitation(session, email=body.email, config=config)
    return SelfServeInvitationRequestAccepted(message=_REQUEST_ACCEPTED_MESSAGE)


def _self_serve_open(config: SignupConfig) -> bool:
    """Startup refuses self_serve without a transport; this keeps the door
    shut if one is missing at runtime anyway, since a link that cannot be
    mailed must not be issued."""
    return config.self_serve and get_email_service().is_configured


def _enforce_self_serve_rate_limits(
    request: Request, email: str, config: SignupConfig
) -> None:
    """Per-IP and per-email sliding windows, both 429 with Retry-After.

    Both are checked before either is recorded, and neither depends on
    what is stored for the address, so a 429 says nothing about accounts.
    """
    self_serve_ip_rate_limiter.max_attempts = config.requests_per_hour_per_ip
    ip_key = get_client_ip(request)
    email_key = normalize_email(email)

    retry_after = 0
    if not self_serve_ip_rate_limiter.is_allowed(ip_key):
        retry_after = self_serve_ip_rate_limiter.get_retry_after(ip_key)
    if not self_serve_email_rate_limiter.is_allowed(email_key):
        retry_after = max(
            retry_after, self_serve_email_rate_limiter.get_retry_after(email_key)
        )
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again later.",
            headers={"Retry-After": str(retry_after)},
        )
    self_serve_ip_rate_limiter.record_attempt(ip_key)
    self_serve_email_rate_limiter.record_attempt(email_key)


_REQUEST_ACCEPTED_MESSAGE = "If the address is eligible, an invitation is on its way."
