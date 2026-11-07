"""Hosted access invitation service.

Owns every state transition for ``HostedAccessInvitationDB`` rows so
routes stay thin. Admission is installation-level: issuing an invitation
creates no User, Project, or membership; acceptance materializes exactly
one invitee-owned Project in a single transaction.

Token mechanics — generation, hashing, expiry, accept URLs, and
best-effort email delivery with a ``link_only`` fallback — live in
``invitation_tokens`` and are shared with the project-invitation flow;
the raw token is returned exactly once to the caller (for delivery /
copy-link) and compared only as a SHA-256 hash afterwards.

Acceptance owns one transaction: user (when new), Project, owner
membership, and invitation consumption are staged with ``flush`` only
and committed once. Any failure rolls the whole acceptance back, leaving
the invitation active and creating neither a partial User nor an
ownerless Project.

Authorization (who may issue/list/revoke) is delegated to the
installation-admin guard; this service never consults Project
membership.
"""

# pyright: reportPrivateUsage=false, reportUnknownArgumentType=false

from __future__ import annotations

import os
from typing import Final, cast
from uuid import uuid4

from fastapi import HTTPException
from sqlmodel import Session, select

from ..auth import hash_password, validate_password_strength
from ..db_helpers import as_column
from ..models.db import (
    HostedAccessInvitationDB,
    ProjectDB,
    ProjectMembershipDB,
    UserDB,
)
from ..models.schemas import (
    AcceptHostedAccessResponse,
    CreateHostedAccessInvitationResponse,
    HostedAccessInvitationPreview,
    HostedAccessInvitationSummary,
)
from .email_admission import require_admissible_email
from .email_templates import render_hosted_access_email
from .invitation_tokens import (
    build_invite_url,
    expiry_from_now,
    generate_token,
    hash_token,
    is_active,
    is_expired,
    normalize_email,
    reconcile_delivery_method,
    rotate_token,
    send_invitation_email,
    utcnow,
)

# Env-tunable admission lifetime, defaulting to 7 days like Project
# Invitations. Long enough for a slow invitee without dangling tokens.
HOSTED_ACCESS_INVITATION_TTL_HOURS: Final[int] = int(
    os.environ.get("HOSTED_ACCESS_INVITATION_TTL_HOURS", "168")
)

_PROJECT_NAME_MAX_LENGTH: Final[int] = 100

_ACCEPT_PATH = "/join"


def _validate_project_name(project_name: str) -> str:
    cleaned = project_name.strip()
    if not cleaned:
        raise HTTPException(
            status_code=422, detail="Project name is required"
        )
    if len(cleaned) > _PROJECT_NAME_MAX_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Project name must be at most {_PROJECT_NAME_MAX_LENGTH} characters"
            ),
        )
    return cleaned


# ---------------------------------------------------------------------------
# Loading helpers
# ---------------------------------------------------------------------------


def get_hosted_access_invitation(
    session: Session, invitation_id: str
) -> HostedAccessInvitationDB | None:
    return session.get(HostedAccessInvitationDB, invitation_id)


def find_active_hosted_access_invitation(
    session: Session, email: str
) -> HostedAccessInvitationDB | None:
    """Return the single active admission row for a normalized email.

    Expired-but-active rows are still returned so a re-invite refreshes
    them in place instead of inserting a second active row.
    """
    normalized = normalize_email(email)
    statement = select(HostedAccessInvitationDB).where(
        HostedAccessInvitationDB.email == normalized,
        as_column(cast(object, HostedAccessInvitationDB.accepted_at)).is_(None),
        as_column(cast(object, HostedAccessInvitationDB.revoked_at)).is_(None),
    )
    return session.exec(statement).first()


def _find_by_raw_token(
    session: Session, raw_token: str
) -> HostedAccessInvitationDB | None:
    token_hash = hash_token(raw_token)
    statement = select(HostedAccessInvitationDB).where(
        HostedAccessInvitationDB.token_hash == token_hash
    )
    return session.exec(statement).first()


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def _to_summary(invitation: HostedAccessInvitationDB) -> HostedAccessInvitationSummary:
    return HostedAccessInvitationSummary(
        id=invitation.id,
        email=invitation.email,
        delivery_method=invitation.delivery_method,
        expires_at=invitation.expires_at,
        created_at=invitation.created_at,
        invited_by_user_id=invitation.invited_by_user_id,
        accepted_at=invitation.accepted_at,
        accepted_by_user_id=invitation.accepted_by_user_id,
        accepted_project_id=invitation.accepted_project_id,
        revoked_at=invitation.revoked_at,
    )


# ---------------------------------------------------------------------------
# Email delivery
# ---------------------------------------------------------------------------


async def _try_send_email(
    session: Session, invitation: HostedAccessInvitationDB, raw_token: str
) -> bool:
    """Attempt admission-invitation delivery. Returns ``True`` if actually sent."""
    inviter = session.get(UserDB, invitation.invited_by_user_id)
    inviter_name = (inviter.name if inviter and inviter.name else None) or "An apo administrator"

    def render(invite_url: str) -> tuple[str, str]:
        return render_hosted_access_email(
            invite_url=invite_url, inviter_name=inviter_name
        )

    return await send_invitation_email(
        to_email=invitation.email,
        subject="You're invited to apo",
        invite_url=build_invite_url(raw_token, _ACCEPT_PATH),
        render=render,
        invitation_id=invitation.id,
        log_label="Hosted access",
    )


# ---------------------------------------------------------------------------
# Issue / list / revoke / resend
# ---------------------------------------------------------------------------


async def create_or_refresh_hosted_access_invitation(
    session: Session,
    *,
    email: str,
    invited_by_user_id: str,
) -> CreateHostedAccessInvitationResponse:
    """Create an admission invitation or refresh the active one for the email.

    Idempotent per normalized email: re-inviting rotates the token and
    refreshes expiry on the existing active row rather than creating a
    second one. No User, Project, or membership row is touched. The raw
    token is returned exactly once in the response (copy-link fallback).
    """
    normalized = normalize_email(email)
    if not normalized or "@" not in normalized:
        raise HTTPException(
            status_code=422, detail="A valid email address is required"
        )
    require_admissible_email(normalized)

    raw_token, token_hash = generate_token()
    invite_url = build_invite_url(raw_token, _ACCEPT_PATH)
    expires_at = expiry_from_now(HOSTED_ACCESS_INVITATION_TTL_HOURS)

    existing = find_active_hosted_access_invitation(session, normalized)
    if existing is not None:
        existing.token_hash = token_hash
        existing.invited_by_user_id = invited_by_user_id
        existing.expires_at = expires_at
        existing.updated_at = utcnow()
        session.add(existing)
        session.commit()
        session.refresh(existing)
        invitation = existing
    else:
        invitation = HostedAccessInvitationDB(
            email=normalized,
            invited_by_user_id=invited_by_user_id,
            token_hash=token_hash,
            delivery_method="email",
            expires_at=expires_at,
        )
        session.add(invitation)
        session.commit()
        session.refresh(invitation)

    delivered = await _try_send_email(session, invitation, raw_token)
    await reconcile_delivery_method(session, invitation, delivered)

    return CreateHostedAccessInvitationResponse(
        invitation=_to_summary(invitation),
        invite_url=None if delivered else invite_url,
        delivery_status="sent" if delivered else "link_only",
    )


async def resend_hosted_access_invitation(
    session: Session,
    *,
    invitation_id: str,
) -> CreateHostedAccessInvitationResponse:
    """Rotate the token and re-attempt delivery on an existing invitation."""
    invitation = get_hosted_access_invitation(session, invitation_id)
    if invitation is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if not is_active(invitation):
        raise HTTPException(
            status_code=409, detail="Invitation is no longer active"
        )

    raw_token, invite_url = rotate_token(
        session,
        invitation,
        ttl_hours=HOSTED_ACCESS_INVITATION_TTL_HOURS,
        accept_path=_ACCEPT_PATH,
    )

    delivered = await _try_send_email(session, invitation, raw_token)
    await reconcile_delivery_method(session, invitation, delivered)

    return CreateHostedAccessInvitationResponse(
        invitation=_to_summary(invitation),
        invite_url=None if delivered else invite_url,
        delivery_status="sent" if delivered else "link_only",
    )


def revoke_hosted_access_invitation(
    session: Session,
    *,
    invitation_id: str,
) -> None:
    """Mark an admission invitation revoked. Idempotent."""
    invitation = get_hosted_access_invitation(session, invitation_id)
    if invitation is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if invitation.revoked_at is None:
        invitation.revoked_at = utcnow()
        invitation.updated_at = utcnow()
        session.add(invitation)
        session.commit()


def list_hosted_access_invitations(
    session: Session,
) -> list[HostedAccessInvitationSummary]:
    """All admission invitations, newest first (administrator view).

    Expired and revoked rows stay visible so they can be resent or
    audited; acceptance state is part of the summary.
    """
    statement = select(HostedAccessInvitationDB).order_by(
        as_column(cast(object, HostedAccessInvitationDB.created_at)).desc()
    )
    rows = list(session.exec(statement).all())
    return [_to_summary(row) for row in rows]


# ---------------------------------------------------------------------------
# Token resolution, preview, and acceptance
# ---------------------------------------------------------------------------


def _resolve_token(
    session: Session, raw_token: str
) -> HostedAccessInvitationDB | None:
    """Resolve a raw token to its invitation row, or ``None`` if unknown."""
    return _find_by_raw_token(session, raw_token)


def _require_acceptable(
    invitation: HostedAccessInvitationDB | None,
) -> HostedAccessInvitationDB:
    """Map a resolved row to the accept-error contract.

    Unknown and expired tokens are opaque 404s; revoked and accepted
    rows are explicit 409s. Neither response reveals the invited email.
    """
    if invitation is None:
        raise HTTPException(status_code=404, detail="Invitation is invalid or has expired")
    if invitation.revoked_at is not None:
        raise HTTPException(status_code=409, detail="Invitation has been revoked")
    if invitation.accepted_at is not None:
        raise HTTPException(status_code=409, detail="Invitation has already been accepted")
    if is_expired(invitation):
        raise HTTPException(status_code=404, detail="Invitation is invalid or has expired")
    return invitation


def preview_hosted_access_invitation(
    session: Session, raw_token: str
) -> HostedAccessInvitationPreview:
    """Public preview of an admission token (no auth required)."""
    invitation = _resolve_token(session, raw_token)
    if invitation is None:
        return HostedAccessInvitationPreview(valid=False, reason="invalid")

    if invitation.revoked_at is not None:
        return HostedAccessInvitationPreview(valid=False, reason="revoked")
    if invitation.accepted_at is not None:
        return HostedAccessInvitationPreview(valid=False, reason="accepted")
    if is_expired(invitation):
        return HostedAccessInvitationPreview(valid=False, reason="expired")

    existing_user = session.exec(
        select(UserDB).where(UserDB.email == invitation.email)
    ).first()
    return HostedAccessInvitationPreview(
        valid=True,
        reason=None,
        email=invitation.email,
        requires_login=existing_user is not None,
        requires_account_creation=existing_user is None,
    )


# ---------------------------------------------------------------------------
# Staging primitives (flush-only; acceptance owns the single commit)
# ---------------------------------------------------------------------------


def _stage_new_user(
    session: Session, *, email: str, name: str, password: str
) -> UserDB:
    """Stage the invited non-admin User. Follows Project Invitation
    acceptance semantics: the delivered invitation satisfies the email
    challenge, so ``email_verified_at`` is set."""
    user = UserDB(
        email=email,
        name=name,
        password_hash=hash_password(password),
        is_admin=False,
        is_active=True,
        email_verified_at=utcnow(),
    )
    session.add(user)
    session.flush()
    return user


def _stage_project(session: Session, *, name: str, created_by: str) -> ProjectDB:
    """Stage the one Project this admission materializes."""
    project = ProjectDB(
        id=uuid4().hex[:12],
        name=name,
        created_by=created_by,
    )
    session.add(project)
    session.flush()
    return project


def _stage_owner_membership(
    session: Session, *, project_id: str, user_id: str
) -> ProjectMembershipDB:
    """Stage the invitee's ``owner`` membership — the only membership
    acceptance ever creates (the issuer receives none)."""
    now = utcnow()
    membership = ProjectMembershipDB(
        project_id=project_id,
        user_id=user_id,
        role="owner",
        created_at=now,
        updated_at=now,
    )
    session.add(membership)
    session.flush()
    return membership


def _stage_accepted(
    session: Session,
    invitation: HostedAccessInvitationDB,
    *,
    user_id: str,
    project_id: str,
) -> None:
    """Stage invitation consumption in the same transaction."""
    invitation.accepted_at = utcnow()
    invitation.accepted_by_user_id = user_id
    invitation.accepted_project_id = project_id
    invitation.updated_at = utcnow()
    session.add(invitation)
    session.flush()


# ---------------------------------------------------------------------------
# Acceptance
# ---------------------------------------------------------------------------


def accept_hosted_access_create_account(
    session: Session,
    *,
    raw_token: str,
    name: str,
    password: str,
    project_name: str,
) -> AcceptHostedAccessResponse:
    """Create a brand-new User and their own Project from a valid token.

    One transaction: the staged User, Project, owner membership, and
    invitation consumption commit together or not at all.
    """
    invitation = _require_acceptable(_resolve_token(session, raw_token))

    password_error = validate_password_strength(password)
    if password_error:
        raise HTTPException(status_code=422, detail=password_error)

    name_clean = name.strip()
    if not name_clean:
        raise HTTPException(status_code=422, detail="Name is required")

    project_name_clean = _validate_project_name(project_name)

    existing_user = session.exec(
        select(UserDB).where(UserDB.email == invitation.email)
    ).first()
    if existing_user is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "An account with that email already exists. "
                "Sign in and accept the invitation instead."
            ),
        )

    try:
        user = _stage_new_user(
            session, email=invitation.email, name=name_clean, password=password
        )
        project = _stage_project(
            session, name=project_name_clean, created_by=user.id
        )
        _ = _stage_owner_membership(
            session, project_id=project.id, user_id=user.id
        )
        _stage_accepted(
            session, invitation, user_id=user.id, project_id=project.id
        )
        session.commit()
    except HTTPException:
        session.rollback()
        raise
    except Exception:
        session.rollback()
        raise

    session.refresh(project)
    return AcceptHostedAccessResponse(status="accepted", project_id=project.id)


def accept_hosted_access_existing_account(
    session: Session,
    *,
    raw_token: str,
    accepting_user_id: str,
    project_name: str,
) -> AcceptHostedAccessResponse:
    """Materialize the invited Project for an already-authenticated User.

    The signed-in User's normalized email must match the invitation
    email; a mismatch is a 409 that consumes nothing. One transaction:
    Project, owner membership, and invitation consumption commit
    together or not at all.
    """
    invitation = _require_acceptable(_resolve_token(session, raw_token))

    project_name_clean = _validate_project_name(project_name)

    accepting_user = session.get(UserDB, accepting_user_id)
    if accepting_user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not accepting_user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated")

    if normalize_email(accepting_user.email) != normalize_email(invitation.email):
        raise HTTPException(
            status_code=409,
            detail=(
                "This invitation is for a different email address. "
                "Sign in with the invited email to accept it."
            ),
        )

    try:
        project = _stage_project(
            session, name=project_name_clean, created_by=accepting_user.id
        )
        _ = _stage_owner_membership(
            session, project_id=project.id, user_id=accepting_user.id
        )
        _stage_accepted(
            session,
            invitation,
            user_id=accepting_user.id,
            project_id=project.id,
        )
        session.commit()
    except HTTPException:
        session.rollback()
        raise
    except Exception:
        session.rollback()
        raise

    session.refresh(project)
    return AcceptHostedAccessResponse(status="accepted", project_id=project.id)


__all__ = [
    "HOSTED_ACCESS_INVITATION_TTL_HOURS",
    "accept_hosted_access_create_account",
    "accept_hosted_access_existing_account",
    "create_or_refresh_hosted_access_invitation",
    "find_active_hosted_access_invitation",
    "get_hosted_access_invitation",
    "list_hosted_access_invitations",
    "preview_hosted_access_invitation",
    "resend_hosted_access_invitation",
    "revoke_hosted_access_invitation",
]
