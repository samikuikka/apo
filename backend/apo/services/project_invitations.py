"""Project invitation service.

Owns every state transition for ``ProjectInvitationDB`` rows so routes
stay thin. Token mechanics — generation, hashing, expiry, accept URLs,
and best-effort email delivery with a ``link_only`` fallback — live in
``invitation_tokens`` and are shared with the hosted-access flow; the
raw token never leaves these modules except to be returned once to the
caller (for delivery / copy-link) or compared as a hash during
preview/accept.

Authorization (who may invite / revoke / resend) is delegated to the
project membership service via ``require_project_role``. This service
never consults ``UserDB.is_admin``.

Email delivery is best-effort: when the configured transport is
log-only (or raises), invitation creation still succeeds and the caller
receives a copyable ``invite_url``.
"""

# pyright: reportPrivateUsage=false, reportUnknownArgumentType=false

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final, cast

from fastapi import HTTPException
from sqlmodel import Session, select

from ..auth import hash_password, validate_password_strength
from ..db_helpers import as_column
from ..models.db import (
    ProjectDB,
    ProjectInvitationDB,
    ProjectMembershipDB,
    UserDB,
)
from ..models.schemas import (
    CreateProjectInvitationRequest,
    CreateProjectInvitationResponse,
    InvitationTokenPreviewResponse,
    ProjectInvitationSummary,
)
from .email_templates import render_invitation_email
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
from .project_memberships import (
    DEMO_PROJECT_ID,
    _ROLE_RANK,
    create_owner_membership,
    get_project_membership,
)

# Env-tunable invitation lifetime. 7 days matches the spec default and
# is long enough for a slow invitee without leaving tokens dangling.
PROJECT_INVITATION_TTL_HOURS: Final[int] = int(
    os.environ.get("PROJECT_INVITATION_TTL_HOURS", "168")
)

# Valid invitation roles. ``owner`` is special-cased at the route layer
# because only owners may invite owners.
_INVITATION_ROLES: Final[frozenset[str]] = frozenset({"owner", "admin", "member", "viewer"})

_ACCEPT_PATH = "/accept-invitation"


# ---------------------------------------------------------------------------
# Loading helpers
# ---------------------------------------------------------------------------


def get_invitation(session: Session, invitation_id: str) -> ProjectInvitationDB | None:
    return session.get(ProjectInvitationDB, invitation_id)


def find_active_invitation(
    session: Session, project_id: str, email: str
) -> ProjectInvitationDB | None:
    """Return the single active pending invitation for ``(project_id, email)``.

    Returns ``None`` if there is no active row. Active means both
    ``accepted_at`` and ``revoked_at`` are ``None``; expired-but-active
    rows are still returned so the caller can refresh them in place on
    re-invite.
    """
    normalized = normalize_email(email)
    statement = select(ProjectInvitationDB).where(
        ProjectInvitationDB.project_id == project_id,
        ProjectInvitationDB.email == normalized,
        as_column(cast(object, ProjectInvitationDB.accepted_at)).is_(None),
        as_column(cast(object, ProjectInvitationDB.revoked_at)).is_(None),
    )
    return session.exec(statement).first()


def find_by_raw_token(
    session: Session, raw_token: str
) -> ProjectInvitationDB | None:
    """Look up an invitation by hashing the raw token."""
    token_hash = hash_token(raw_token)
    statement = select(ProjectInvitationDB).where(
        ProjectInvitationDB.token_hash == token_hash
    )
    return session.exec(statement).first()


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def _inviter_name(session: Session, user_id: str) -> str | None:
    user = session.get(UserDB, user_id)
    if user is None or not user.name:
        return None
    return user.name


def to_summary(
    session: Session,
    invitation: ProjectInvitationDB,
    *,
    can_resend: bool = True,
    can_revoke: bool = True,
) -> ProjectInvitationSummary:
    return ProjectInvitationSummary(
        id=invitation.id,
        email=invitation.email,
        role=invitation.role,
        delivery_method=invitation.delivery_method,
        created_at=invitation.created_at,
        expires_at=invitation.expires_at,
        invited_by_user_id=invitation.invited_by_user_id,
        invited_by_name=_inviter_name(session, invitation.invited_by_user_id),
        can_resend=can_resend,
        can_revoke=can_revoke,
    )


# ---------------------------------------------------------------------------
# Email delivery
# ---------------------------------------------------------------------------


async def _try_send_email(
    session: Session,
    invitation: ProjectInvitationDB,
    raw_token: str,
) -> bool:
    """Attempt project-invitation delivery. Returns ``True`` if actually sent."""
    inviter = session.get(UserDB, invitation.invited_by_user_id)
    project = session.get(ProjectDB, invitation.project_id)
    inviter_name = (inviter.name if inviter and inviter.name else None) or "Someone"
    project_name = project.name if project else "a project"

    def render(invite_url: str) -> tuple[str, str]:
        return render_invitation_email(
            invite_url=invite_url,
            inviter_name=inviter_name,
            workspace_name=project_name,
        )

    return await send_invitation_email(
        to_email=invitation.email,
        subject=f"You're invited to join {project_name}",
        invite_url=build_invite_url(raw_token, _ACCEPT_PATH),
        render=render,
        invitation_id=invitation.id,
        log_label="Invitation",
    )


# ---------------------------------------------------------------------------
# Mutation entrypoints
# ---------------------------------------------------------------------------


async def create_or_refresh_invitation(
    session: Session,
    *,
    project_id: str,
    body: CreateProjectInvitationRequest,
    invited_by_user_id: str,
    invited_by_role: str,
) -> CreateProjectInvitationResponse:
    """Create a new invitation or refresh an existing active one.

    Idempotent for the same ``(project_id, email)``: re-inviting rotates
    the token, refreshes expiry, updates role + inviter, and re-attempts
    delivery. The raw token is returned exactly once in the response so
    the caller can show a copy-link affordance when email is unavailable.
    """
    if project_id == DEMO_PROJECT_ID:
        raise HTTPException(
            status_code=403,
            detail="Demo project does not support invitations",
        )

    role = body.role.strip()
    if role not in _INVITATION_ROLES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Invalid role '{role}'. Expected one of: owner, admin, member."
            ),
        )
    if role == "owner" and invited_by_role != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only owners can invite new owners to a project",
        )
    # Grant-rank rule: invite at most at your own rank.
    inviter_rank = _ROLE_RANK.get(invited_by_role, 0)
    if _ROLE_RANK.get(role, 0) > inviter_rank:
        raise HTTPException(
            status_code=403,
            detail="Cannot invite at a role above your own",
        )

    normalized = normalize_email(body.email)
    if not normalized or "@" not in normalized:
        raise HTTPException(
            status_code=422, detail="A valid email address is required"
        )

    # Block invites to existing members of the project.
    member_user = session.exec(
        select(UserDB).where(UserDB.email == normalized)
    ).first()
    if member_user is not None:
        existing_membership = get_project_membership(session, project_id, member_user.id)
        if existing_membership is not None:
            raise HTTPException(
                status_code=409,
                detail="That user is already a member of this project",
            )

    raw_token, token_hash = generate_token()
    invite_url = build_invite_url(raw_token, _ACCEPT_PATH)
    expires_at = expiry_from_now(PROJECT_INVITATION_TTL_HOURS)

    existing = find_active_invitation(session, project_id, normalized)
    if existing is not None:
        existing.token_hash = token_hash
        existing.role = role
        existing.invited_by_user_id = invited_by_user_id
        existing.expires_at = expires_at
        existing.updated_at = utcnow()
        session.add(existing)
        session.commit()
        session.refresh(existing)
        invitation = existing
    else:
        invitation = ProjectInvitationDB(
            project_id=project_id,
            email=normalized,
            role=role,
            invited_by_user_id=invited_by_user_id,
            token_hash=token_hash,
            invite_url_path=f"{_ACCEPT_PATH}?token={raw_token}",
            delivery_method="email",
            expires_at=expires_at,
        )
        session.add(invitation)
        session.commit()
        session.refresh(invitation)

    delivered = await _try_send_email(session, invitation, raw_token)
    await reconcile_delivery_method(session, invitation, delivered)

    summary = to_summary(session, invitation)
    return CreateProjectInvitationResponse(
        invitation=summary,
        invite_url=None if delivered else invite_url,
        delivery_status="sent" if delivered else "link_only",
    )


async def resend_invitation(
    session: Session,
    *,
    project_id: str,
    invitation_id: str,
) -> CreateProjectInvitationResponse:
    """Rotate the token and re-attempt delivery on an existing invitation."""
    if project_id == DEMO_PROJECT_ID:
        raise HTTPException(
            status_code=403,
            detail="Demo project does not support invitations",
        )

    invitation = get_invitation(session, invitation_id)
    if invitation is None or invitation.project_id != project_id:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if not is_active(invitation):
        raise HTTPException(
            status_code=409, detail="Invitation is no longer active"
        )

    raw_token, invite_url = rotate_token(
        session,
        invitation,
        ttl_hours=PROJECT_INVITATION_TTL_HOURS,
        accept_path=_ACCEPT_PATH,
    )

    delivered = await _try_send_email(session, invitation, raw_token)
    await reconcile_delivery_method(session, invitation, delivered)

    summary = to_summary(session, invitation)
    return CreateProjectInvitationResponse(
        invitation=summary,
        invite_url=None if delivered else invite_url,
        delivery_status="sent" if delivered else "link_only",
    )


def revoke_invitation(
    session: Session,
    *,
    project_id: str,
    invitation_id: str,
    actor_role: str,
) -> None:
    """Mark an invitation as revoked. Idempotent for already-revoked rows.

    Owner-role invitations may only be revoked by owners (last-owner
    safety analog). Hard deletes are never performed.
    """
    if project_id == DEMO_PROJECT_ID:
        raise HTTPException(
            status_code=403,
            detail="Demo project does not support invitations",
        )

    invitation = get_invitation(session, invitation_id)
    if invitation is None or invitation.project_id != project_id:
        raise HTTPException(status_code=404, detail="Invitation not found")

    if invitation.role == "owner" and actor_role != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only owners can revoke owner-role invitations",
        )

    if invitation.revoked_at is None:
        invitation.revoked_at = utcnow()
        invitation.updated_at = utcnow()
        session.add(invitation)
        session.commit()


def list_pending_invitations(
    session: Session, *, project_id: str
) -> list[ProjectInvitationSummary]:
    """Return only active (non-accepted, non-revoked) invitations."""
    statement = (
        select(ProjectInvitationDB)
        .where(
            ProjectInvitationDB.project_id == project_id,
            as_column(cast(object, ProjectInvitationDB.accepted_at)).is_(None),
            as_column(cast(object, ProjectInvitationDB.revoked_at)).is_(None),
        )
        .order_by(
            as_column(cast(object, ProjectInvitationDB.created_at)).desc()
        )
    )
    rows = list(session.exec(statement).all())
    return [to_summary(session, row) for row in rows]


# ---------------------------------------------------------------------------
# Token preview + acceptance
# ---------------------------------------------------------------------------


@dataclass
class _ResolvedToken:
    """Internal resolution result used by both preview and accept paths.

    ``project`` is ``None`` only when the project row was deleted out
    from under an outstanding invitation; callers treat that the same as
    an invalid token. ``reason`` is set when the token resolved to a row
    that cannot be accepted right now (expired / revoked / already
    accepted).
    """

    invitation: ProjectInvitationDB
    project: ProjectDB | None
    reason: str | None


def _resolve_token(
    session: Session, raw_token: str
) -> _ResolvedToken | None:
    """Resolve a raw token to its invitation row.

    Returns ``None`` when no row matches (so callers can emit a generic
    invalid response without leaking token existence).
    """
    invitation = find_by_raw_token(session, raw_token)
    if invitation is None:
        return None
    project = session.get(ProjectDB, invitation.project_id)
    if project is None:
        return _ResolvedToken(invitation=invitation, project=None, reason="invalid")
    if invitation.revoked_at is not None:
        return _ResolvedToken(invitation=invitation, project=project, reason="revoked")
    if invitation.accepted_at is not None:
        return _ResolvedToken(invitation=invitation, project=project, reason="accepted")
    if is_expired(invitation):
        return _ResolvedToken(invitation=invitation, project=project, reason="expired")
    return _ResolvedToken(invitation=invitation, project=project, reason=None)


def preview_invitation_token(
    session: Session, raw_token: str
) -> InvitationTokenPreviewResponse:
    """Public preview of an invitation token (no auth required)."""
    resolved = _resolve_token(session, raw_token)
    if resolved is None or resolved.project is None or resolved.reason is not None:
        reason = resolved.reason if resolved is not None else "invalid"
        return InvitationTokenPreviewResponse(
            valid=False,
            reason=reason,
            requires_login=False,
            requires_account_creation=False,
        )

    invitation = resolved.invitation
    existing_user = session.exec(
        select(UserDB).where(UserDB.email == invitation.email)
    ).first()
    requires_account_creation = existing_user is None
    requires_login = existing_user is not None

    return InvitationTokenPreviewResponse(
        valid=True,
        reason=None,
        email=invitation.email,
        project_id=resolved.project.id,
        project_name=resolved.project.name,
        role=invitation.role,
        requires_login=requires_login,
        requires_account_creation=requires_account_creation,
    )


def accept_invitation_create_account(
    session: Session,
    *,
    raw_token: str,
    name: str,
    password: str,
) -> tuple[ProjectMembershipDB, ProjectInvitationDB]:
    """Create a brand-new user + project membership from a valid token.

    Returns ``(membership, invitation)``. Raises ``HTTPException`` on
    any precondition failure (invalid/expired token, email collision,
    weak password).
    """
    resolved = _resolve_token(session, raw_token)
    if resolved is None or resolved.project is None or resolved.reason is not None:
        raise HTTPException(
            status_code=404, detail="Invitation is invalid or has expired"
        )

    invitation = resolved.invitation
    project = resolved.project

    password_error = validate_password_strength(password)
    if password_error:
        raise HTTPException(status_code=422, detail=password_error)

    name_clean = name.strip()
    if not name_clean:
        raise HTTPException(status_code=422, detail="Name is required")

    # Race protection: if someone created an account for this email
    # between preview and accept, fall back to the existing-user path.
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

    user = UserDB(
        email=invitation.email,
        name=name_clean,
        password_hash=hash_password(password),
        is_admin=False,
        is_active=True,
        email_verified_at=utcnow(),
    )
    session.add(user)
    session.commit()
    session.refresh(user)

    membership = _materialize_membership(
        session, project_id=project.id, user=user, role=invitation.role
    )
    _mark_accepted(session, invitation, user.id)
    return membership, invitation


def accept_invitation_existing_account(
    session: Session,
    *,
    raw_token: str,
    accepting_user_id: str,
) -> tuple[ProjectMembershipDB, ProjectInvitationDB]:
    """Attach a valid invitation to an already-authenticated user.

    The signed-in user's email must match the invitation email exactly
    after normalization. Any mismatch raises ``409`` and does not
    consume the token.
    """
    resolved = _resolve_token(session, raw_token)
    if resolved is None or resolved.project is None or resolved.reason is not None:
        raise HTTPException(
            status_code=404, detail="Invitation is invalid or has expired"
        )

    invitation = resolved.invitation
    project = resolved.project

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

    membership = _materialize_membership(
        session, project_id=project.id, user=accepting_user, role=invitation.role
    )
    _mark_accepted(session, invitation, accepting_user.id)
    return membership, invitation


# ---------------------------------------------------------------------------
# Acceptance helpers
# ---------------------------------------------------------------------------


def _materialize_membership(
    session: Session,
    *,
    project_id: str,
    user: UserDB,
    role: str,
) -> ProjectMembershipDB:
    """Create the membership row, ignoring duplicates if already a member."""
    existing = get_project_membership(session, project_id, user.id)
    if existing is not None:
        # Idempotent: keep the existing role to avoid accidental
        # downgrades if the user was added through another path.
        return existing
    if role == "owner":
        return create_owner_membership(session, project_id, user.id)
    return _create_membership_row(
        session, project_id=project_id, user_id=user.id, role=role
    )


def _create_membership_row(
    session: Session,
    *,
    project_id: str,
    user_id: str,
    role: str,
) -> ProjectMembershipDB:
    now = utcnow()
    membership = ProjectMembershipDB(
        project_id=project_id,
        user_id=user_id,
        role=role,
        created_at=now,
        updated_at=now,
    )
    session.add(membership)
    session.commit()
    session.refresh(membership)
    return membership


def _mark_accepted(
    session: Session, invitation: ProjectInvitationDB, accepting_user_id: str
) -> None:
    invitation.accepted_at = utcnow()
    invitation.accepted_by_user_id = accepting_user_id
    invitation.updated_at = utcnow()
    session.add(invitation)
    session.commit()


__all__ = [
    "PROJECT_INVITATION_TTL_HOURS",
    "accept_invitation_create_account",
    "accept_invitation_existing_account",
    "create_or_refresh_invitation",
    "find_active_invitation",
    "find_by_raw_token",
    "get_invitation",
    "hash_token",
    "list_pending_invitations",
    "normalize_email",
    "preview_invitation_token",
    "resend_invitation",
    "revoke_invitation",
    "to_summary",
]
