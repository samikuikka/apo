"""Hosted access invitation service.

Owns every state transition for ``HostedAccessInvitationDB`` rows so
routes stay thin. Admission is installation-level: issuing an invitation
creates no User, Project, or membership; acceptance materializes exactly
one invitee-owned Project in a single transaction.

An invitation has one of two origins. ``admin`` rows are issued by an
Installation Administrator, who may receive the accept link to share
out-of-band when email is unavailable. ``self_serve`` rows are requested
by a visitor for their own address: the link reaches that inbox or
nobody, so it is never returned or logged, and the account it creates
must verify its email before it can sign in.

Token mechanics (generation, hashing, expiry, accept URLs, and
best-effort email delivery with a ``link_only`` fallback) live in
``invitation_tokens`` and are shared with the project-invitation flow;
the raw token is returned exactly once to the caller (for delivery /
copy-link) and compared only as a SHA-256 hash afterwards.

Acceptance owns one transaction: it first claims the invitation with a
conditional update, then stages the user (when new), Project, and owner
membership with ``flush`` only, and commits once. Any failure rolls the
whole acceptance back, leaving the invitation active and creating
neither a partial User nor an ownerless Project.

Authorization (who may issue/list/revoke) is delegated to the
installation-admin guard; this service never consults Project
membership.
"""

# pyright: reportPrivateUsage=false, reportUnknownArgumentType=false

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Final, cast
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
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
from .email_admission import require_admissible_email, require_email_shape
from .email_templates import (
    render_hosted_access_email,
    render_self_serve_access_email,
)
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
from .signup_config import SignupConfig, load_signup_config

# Env-tunable admission lifetime, defaulting to 7 days like Project
# Invitations. Long enough for a slow invitee without dangling tokens.
HOSTED_ACCESS_INVITATION_TTL_HOURS: Final[int] = int(
    os.environ.get("HOSTED_ACCESS_INVITATION_TTL_HOURS", "168")
)

# How long after a delivered self-serve invitation a repeat request for
# the same address is a silent no-op. Five minutes covers a double submit
# and slow mail without making someone who lost the message wait long, and
# keeps the request form from being used to flood a third party's inbox.
SELF_SERVE_REREQUEST_WINDOW_MINUTES: Final[int] = 5

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


def mask_email(email: str) -> str:
    """Mask an address for the public preview: ``john@x.com`` -> ``j***n@x.com``.

    The recipient still recognizes their own address; someone holding only
    a pasted link does not learn it. Local parts of one or two characters
    keep just the first, since both ends would be the whole thing. The
    dashboard masks the session email the same way to compare the two.
    """
    local, _, domain = email.rpartition("@")
    tail = local[-1] if len(local) > 2 else ""
    return f"{local[:1]}***{tail}@{domain}"


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
        origin="self_serve" if _is_self_serve(invitation) else "admin",
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
    if _is_self_serve(invitation):
        ttl_hours = _ttl_hours(invitation)
        subject = "Your apo invitation"

        def render(invite_url: str) -> tuple[str, str]:
            return render_self_serve_access_email(
                invite_url=invite_url, ttl_hours=ttl_hours
            )
    else:
        inviter = (
            session.get(UserDB, invitation.invited_by_user_id)
            if invitation.invited_by_user_id
            else None
        )
        inviter_name = (inviter.name if inviter else None) or "An apo administrator"
        subject = "You're invited to apo"

        def render(invite_url: str) -> tuple[str, str]:
            return render_hosted_access_email(
                invite_url=invite_url, inviter_name=inviter_name
            )

    return await send_invitation_email(
        to_email=invitation.email,
        subject=subject,
        invite_url=build_invite_url(raw_token, _ACCEPT_PATH),
        render=render,
        invitation_id=invitation.id,
        log_label="Hosted access",
    )


async def _deliver(
    session: Session, invitation: HostedAccessInvitationDB, raw_token: str
) -> bool:
    """Send the invitation and record how it went on the row."""
    delivered = await _try_send_email(session, invitation, raw_token)
    if not _is_self_serve(invitation):
        await reconcile_delivery_method(session, invitation, delivered)
        return delivered
    delivery_method = "email" if delivered else "failed"
    if invitation.delivery_method != delivery_method:
        invitation.delivery_method = delivery_method
        session.add(invitation)
        session.commit()
        session.refresh(invitation)
    return delivered


def _issued_response(
    invitation: HostedAccessInvitationDB, invite_url: str, delivered: bool
) -> CreateHostedAccessInvitationResponse:
    """The administrator-facing result of a create or resend.

    The copy-link fallback exists for admin-issued rows only. A self-serve
    link belongs to the inbox that asked for it, so an undelivered one is
    reported as ``failed`` and its URL is dropped here, for administrators
    as well.
    """
    if _is_self_serve(invitation):
        return CreateHostedAccessInvitationResponse(
            invitation=_to_summary(invitation),
            invite_url=None,
            delivery_status="sent" if delivered else "failed",
        )
    return CreateHostedAccessInvitationResponse(
        invitation=_to_summary(invitation),
        invite_url=None if delivered else invite_url,
        delivery_status="sent" if delivered else "link_only",
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
    normalized = require_email_shape(email)
    require_admissible_email(normalized)

    raw_token, token_hash = generate_token()
    invite_url = build_invite_url(raw_token, _ACCEPT_PATH)
    expires_at = expiry_from_now(HOSTED_ACCESS_INVITATION_TTL_HOURS)

    existing = find_active_hosted_access_invitation(session, normalized)
    if existing is not None:
        existing.token_hash = token_hash
        existing.invited_by_user_id = invited_by_user_id
        # An administrator re-inviting a self-serve address now vouches
        # for it, so the row takes the admin rules from here on.
        existing.origin = "admin"
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

    delivered = await _deliver(session, invitation, raw_token)
    return _issued_response(invitation, invite_url, delivered)


async def request_self_serve_invitation(
    session: Session,
    *,
    email: str,
    config: SignupConfig,
) -> None:
    """Issue a self-serve invitation for ``email`` and mail the accept link.

    Returns nothing on purpose: the caller answers every request the same
    way, so the response cannot say whether the address has an account, a
    pending invitation, or a delivery problem. The checks that do raise
    (malformed or disposable address, outstanding cap) depend only on the
    address text or on installation-wide state, never on what is stored
    for that address, and run before anything address-specific is read.
    """
    normalized = require_email_shape(email)
    require_admissible_email(normalized)
    _require_outstanding_capacity(session, config.max_outstanding)

    existing_user = session.exec(
        select(UserDB).where(UserDB.email == normalized)
    ).first()
    if existing_user is not None:
        return

    raw_token, token_hash = generate_token()
    expires_at = expiry_from_now(config.invite_ttl_hours)

    invitation = find_active_hosted_access_invitation(session, normalized)
    if invitation is None:
        invitation = HostedAccessInvitationDB(
            email=normalized,
            invited_by_user_id=None,
            origin="self_serve",
            token_hash=token_hash,
            delivery_method="email",
            expires_at=expires_at,
        )
    elif is_expired(invitation):
        # An expired row (admin-issued ones included) can no longer admit
        # anyone, and nothing else ever clears it: without superseding, the
        # address's requests would 202 forever while no link is ever sent.
        invitation.origin = "self_serve"
        invitation.invited_by_user_id = None
        invitation.token_hash = token_hash
        invitation.delivery_method = "email"
        invitation.expires_at = expires_at
        invitation.updated_at = utcnow()
    elif _self_serve_may_refresh(invitation):
        invitation.token_hash = token_hash
        invitation.expires_at = expires_at
        invitation.updated_at = utcnow()
    else:
        return
    session.add(invitation)
    try:
        session.commit()
    except IntegrityError:
        # A concurrent request for the same address won the one-active-row
        # index and is delivering its invitation; this one has nothing to add.
        session.rollback()
        return
    session.refresh(invitation)

    _ = await _deliver(session, invitation, raw_token)


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
        ttl_hours=_ttl_hours(invitation),
        accept_path=_ACCEPT_PATH,
    )

    delivered = await _deliver(session, invitation, raw_token)
    return _issued_response(invitation, invite_url, delivered)


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
        email=mask_email(invitation.email),
        requires_login=existing_user is not None,
        requires_account_creation=existing_user is None,
    )


# ---------------------------------------------------------------------------
# Staging primitives (flush-only; acceptance owns the single commit)
# ---------------------------------------------------------------------------


def _claim(session: Session, invitation: HostedAccessInvitationDB) -> None:
    """Consume the invitation, or 409 when another accept got there first.

    Two requests can both pass ``_require_acceptable`` before either
    writes. Reading and then writing would let both through and mint two
    Projects, so the write itself carries the condition: only one UPDATE
    can match ``accepted_at IS NULL`` and the other sees zero rows. It is
    the first write of the acceptance so the loser stops before staging
    anything.
    """
    now = utcnow()
    result = session.exec(
        update(HostedAccessInvitationDB)
        .where(
            as_column(HostedAccessInvitationDB.id) == invitation.id,
            as_column(cast(object, HostedAccessInvitationDB.accepted_at)).is_(None),
            as_column(cast(object, HostedAccessInvitationDB.revoked_at)).is_(None),
        )
        .values(accepted_at=now, updated_at=now)
    )
    if result.rowcount != 1:
        raise HTTPException(
            status_code=409, detail="Invitation has already been accepted or revoked"
        )
    session.refresh(invitation)


def _stage_new_user(
    session: Session, *, email: str, name: str, password: str, self_serve: bool
) -> UserDB:
    """Stage the invited non-admin User.

    An admin-issued invitation follows Project Invitation acceptance
    semantics: an administrator chose the address and delivered the link,
    which satisfies the email challenge, so ``email_verified_at`` is set.
    Nobody vouched for a self-serve address, so that account starts
    unverified and is flagged to verify before its first sign-in.
    """
    user = UserDB(
        email=email,
        name=name,
        password_hash=hash_password(password),
        is_admin=False,
        is_active=True,
        email_verified_at=None if self_serve else utcnow(),
        requires_email_verification=self_serve,
    )
    session.add(user)
    session.flush()
    return user


def _stage_project(session: Session, *, name: str, created_by: str) -> ProjectDB:
    """Stage the one Project this admission materializes.

    Deliberately not subject to ``enforce_project_count_limit``: the
    invitation is admission (admin-issued or self-serve), so the account's
    max_projects cap does not block the one project admission exists to
    create.
    """
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
    """Stage the invitee's ``owner`` membership, the only membership
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
    """Record who accepted the claimed invitation, and into which Project."""
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

    One transaction: the invitation claim, the staged User, Project, and
    owner membership commit together or not at all.
    """
    invitation = _require_acceptable(_resolve_token(session, raw_token))
    self_serve = _is_self_serve(invitation)

    password_error = validate_password_strength(password)
    if password_error:
        raise HTTPException(status_code=422, detail=password_error)

    name_clean = name.strip()
    if not name_clean:
        raise HTTPException(status_code=422, detail="Name is required")
    _require_invitee_name_length(name_clean)

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

    # Re-check at user creation: invitations issued before the disposable-
    # domain blocklist landed must not admit through the accept path either.
    require_admissible_email(invitation.email)

    try:
        _claim(session, invitation)
        user = _stage_new_user(
            session,
            email=invitation.email,
            name=name_clean,
            password=password,
            self_serve=self_serve,
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
    except Exception:
        session.rollback()
        raise

    session.refresh(project)
    session.refresh(user)
    return AcceptHostedAccessResponse(
        status="accepted",
        project_id=project.id,
        email=user.email,
        email_verification_required=self_serve,
    )


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
    the invitation claim, Project, and owner membership commit together
    or not at all.
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
        _claim(session, invitation)
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
    except Exception:
        session.rollback()
        raise

    session.refresh(project)
    session.refresh(accepting_user)
    return AcceptHostedAccessResponse(
        status="accepted", project_id=project.id, email=accepting_user.email
    )


def _is_self_serve(invitation: HostedAccessInvitationDB) -> bool:
    return invitation.origin == "self_serve"


def _ttl_hours(invitation: HostedAccessInvitationDB) -> int:
    if _is_self_serve(invitation):
        return load_signup_config().invite_ttl_hours
    return HOSTED_ACCESS_INVITATION_TTL_HOURS


MAX_INVITEE_NAME_LENGTH = 120


def _require_invitee_name_length(name: str) -> None:
    """422 on an unbounded name: it is echoed into the mailed invitation."""
    if len(name) > MAX_INVITEE_NAME_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"Name must be at most {MAX_INVITEE_NAME_LENGTH} characters",
        )


def _require_outstanding_capacity(session: Session, max_outstanding: int) -> None:
    """429 when too many self-serve invitations are waiting to be accepted.

    Expired rows do not count: they can no longer be accepted, and
    counting them would let one burst of requests shut the door until an
    administrator revoked them by hand.
    """
    outstanding = session.exec(
        select(func.count())
        .select_from(HostedAccessInvitationDB)
        .where(
            HostedAccessInvitationDB.origin == "self_serve",
            as_column(cast(object, HostedAccessInvitationDB.accepted_at)).is_(None),
            as_column(cast(object, HostedAccessInvitationDB.revoked_at)).is_(None),
            as_column(HostedAccessInvitationDB.expires_at) > utcnow(),
        )
    ).one()
    if outstanding >= max_outstanding:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again later.",
            # Places free up as invitations are accepted or expire, at no
            # fixed time; an hour matches the request limiter's window.
            headers={"Retry-After": "3600"},
        )


def _self_serve_may_refresh(invitation: HostedAccessInvitationDB) -> bool:
    """Whether a repeat request may rotate this active invitation.

    Never an admin-issued one: anyone can type an address into the public
    form, and rotating would kill the link the administrator handed out.
    A self-serve one is rotated unless a link was delivered moments ago.
    """
    if not _is_self_serve(invitation):
        return False
    if invitation.delivery_method != "email" or is_expired(invitation):
        return True
    window = timedelta(minutes=SELF_SERVE_REREQUEST_WINDOW_MINUTES)
    return utcnow() - _as_utc(invitation.updated_at) >= window


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


__all__ = [
    "HOSTED_ACCESS_INVITATION_TTL_HOURS",
    "SELF_SERVE_REREQUEST_WINDOW_MINUTES",
    "accept_hosted_access_create_account",
    "accept_hosted_access_existing_account",
    "create_or_refresh_hosted_access_invitation",
    "find_active_hosted_access_invitation",
    "get_hosted_access_invitation",
    "list_hosted_access_invitations",
    "mask_email",
    "preview_hosted_access_invitation",
    "request_self_serve_invitation",
    "resend_hosted_access_invitation",
    "revoke_hosted_access_invitation",
]
