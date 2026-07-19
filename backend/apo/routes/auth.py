# pyright: reportCallInDefaultInitializer=false, reportPrivateUsage=false

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import (
    _dummy_hash,
    hash_password,
    invalidate_user_sessions,
    validate_frontend_url,
    validate_password_strength,
    verify_password,
)
from ..auth.rate_limit import LoginRateLimiter, login_rate_limiter
from ..db import get_session
from ..db_helpers import _as_column
from ..models.db import EmailVerificationTokenDB, PasswordResetTokenDB, ProjectDB, UserDB
from ..models.schemas import (
    AcceptInvitationCreateAccountRequest,
    AcceptInvitationExistingAccountRequest,
    InvitationTokenPreviewResponse,
    InviteUserRequest,
    ListUsersResponse,
    UpdateUserRequest,
    UserResponse,
)
from ..services.demo_workspace import DEMO_PROJECT_ID
from ..services.project_invitations import (
    accept_invitation_create_account,
    accept_invitation_existing_account,
    preview_invitation_token,
)
from ..services.project_memberships import (
    get_project_membership,
    list_projects_for_user,
)
from ..services.email import EmailSendError, get_email_service
from ..services.email_templates import (
    render_password_reset_email,
    render_verification_email,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

RESET_TOKEN_EXPIRY_HOURS = 1

# Email verification constants
OTP_TTL_MINUTES = 10
MAX_OTP_ATTEMPTS = 5
RESEND_WINDOW_SECONDS = 60

resend_rate_limiter = LoginRateLimiter(
    max_attempts=1, window_seconds=RESEND_WINDOW_SECONDS
)


class SetupRequest(BaseModel):
    email: str
    password: str
    name: str = ""


class VerifyPasswordRequest(BaseModel):
    email: str
    password: str


class VerifyPasswordProject(BaseModel):
    id: str
    name: str
    role: str | None


class VerifyPasswordResponse(BaseModel):
    id: str
    email: str
    name: str
    is_admin: bool
    # Projects the user can mint an API key against (excludes the read-only
    # demo workspace). Lets `apo login` offer a project picker without a
    # throwaway key.
    projects: list[VerifyPasswordProject] = []


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class VerifyEmailRequest(BaseModel):
    email: str
    code: str


class VerifyEmailResponse(BaseModel):
    verified: bool
    message: str


class ResendVerificationRequest(BaseModel):
    email: str


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client = request.client
    return client.host if client else "unknown"


def _utcnow_naive() -> datetime:
    """Current UTC time without timezone info (for SQLite compatibility)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _is_email_verification_required() -> bool:
    """Check if AUTH_EMAIL_VERIFICATION_REQUIRED is enabled."""
    return (
        os.environ.get("AUTH_EMAIL_VERIFICATION_REQUIRED", "false").strip().lower()
        == "true"
    )


def _generate_otp() -> str:
    """Generate a cryptographically random 6-digit code."""
    return str(secrets.randbelow(900000) + 100000)


def _hash_otp(code: str) -> str:
    """SHA256 hash of an OTP code (never store plaintext)."""
    return hashlib.sha256(code.encode()).hexdigest()


async def _create_and_send_otp(user: UserDB, session: Session) -> None:
    """Generate a new OTP, store its hash, and send via email."""
    code = _generate_otp()
    token = EmailVerificationTokenDB(
        user_id=user.id,
        code_hash=_hash_otp(code),
        expires_at=_utcnow_naive() + timedelta(minutes=OTP_TTL_MINUTES),
    )
    session.add(token)
    session.commit()

    if user.email:
        html_body, text_body = render_verification_email(code, user.name)
        try:
            await get_email_service().send(
                to=user.email,
                subject="Verify your email",
                html=html_body,
                text=text_body,
            )
        except EmailSendError:
            logger.warning("Failed to send verification email to %s", user.email)


def _require_admin(request: Request, session: Session) -> UserDB:
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if user_id:
        user = session.get(UserDB, user_id)
        if user and user.is_admin:
            return user
    raise HTTPException(status_code=403, detail="Admin access required")


def _user_to_response(user: UserDB) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        is_admin=user.is_admin,
        is_active=user.is_active,
        created_at=user.created_at.isoformat() if user.created_at else "",
    )


@router.get("/has-users")
def has_users(session: Session = Depends(get_session)) -> dict[str, bool]:
    user = session.exec(select(UserDB)).first()
    return {"has_users": user is not None}


@router.post("/setup")
async def setup(body: SetupRequest, session: Session = Depends(get_session)) -> dict[str, str]:
    error = validate_password_strength(body.password)
    if error:
        raise HTTPException(status_code=422, detail=error)

    existing_user = session.exec(
        select(UserDB).where(UserDB.email == body.email)
    ).first()
    if existing_user:
        raise HTTPException(
            status_code=409, detail="A user with this email already exists"
        )

    verification_required = _is_email_verification_required()

    # SPEC-122: the first user is no longer automatically a product
    # super-admin. Project authorization comes from project
    # memberships (owner on created projects). ``UserDB.is_admin`` is
    # reserved for instance-maintenance flows guarded by
    # ``ADMIN_API_KEY`` and the bootstrap user (INIT_USER).
    user = UserDB(
        email=body.email,
        name=body.name,
        password_hash=hash_password(body.password),
        is_admin=False,
        is_active=True,
        email_verified_at=None if verification_required else _utcnow_naive(),
    )
    session.add(user)
    session.commit()
    session.refresh(user)

    if verification_required:
        await _create_and_send_otp(user, session)
        return {"status": "verification_required", "email": body.email}

    return {"status": "ok", "id": user.id}


@router.post("/verify-password", response_model=VerifyPasswordResponse)
def verify_password_endpoint(
    request: Request,
    body: VerifyPasswordRequest,
    session: Session = Depends(get_session),
):
    ip = _get_client_ip(request)

    if not login_rate_limiter.is_allowed(ip):
        retry_after = login_rate_limiter.get_retry_after(ip)
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts",
            headers={"Retry-After": str(retry_after)},
        )

    login_rate_limiter.record_attempt(ip)

    user = session.exec(
        select(UserDB).where(UserDB.email == body.email)
    ).first()

    if user:
        if not user.is_active:
            _ = verify_password(body.password, _dummy_hash)
            raise HTTPException(status_code=401, detail="Invalid credentials")

        if not verify_password(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Invalid credentials")

        if _is_email_verification_required() and user.email_verified_at is None:
            raise HTTPException(
                status_code=403,
                detail={"message": "Email verification required", "code": "EMAIL_NOT_VERIFIED"},
            )

        member_project_ids = list_projects_for_user(session, user.id)
        accessible_projects: list[VerifyPasswordProject] = []
        for pid in member_project_ids:
            if pid == DEMO_PROJECT_ID:
                continue
            project_row = session.get(ProjectDB, pid)
            if project_row is None:
                continue
            membership = get_project_membership(session, pid, user.id)
            accessible_projects.append(
                VerifyPasswordProject(
                    id=project_row.id,
                    name=project_row.name,
                    role=membership.role if membership else None,
                )
            )

        return VerifyPasswordResponse(
            id=user.id,
            email=user.email,
            name=user.name,
            is_admin=user.is_admin,
            projects=accessible_projects,
        )

    _ = verify_password(body.password, _dummy_hash)
    raise HTTPException(status_code=401, detail="Invalid credentials")


@router.post("/verify-email", response_model=VerifyEmailResponse)
def verify_email(
    body: VerifyEmailRequest, session: Session = Depends(get_session)
) -> VerifyEmailResponse:
    """Validate the 6-digit OTP code. On success, sets email_verified_at."""
    user = session.exec(
        select(UserDB).where(UserDB.email == body.email)
    ).first()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired code")

    if user.email_verified_at is not None:
        return VerifyEmailResponse(verified=True, message="Email already verified")

    token = session.exec(
        select(EmailVerificationTokenDB)
        .where(
            EmailVerificationTokenDB.user_id == user.id,
            _as_column(cast(object, EmailVerificationTokenDB.used_at)).is_(None),
        )
        .order_by(
            _as_column(cast(object, EmailVerificationTokenDB.created_at)).desc()  # pyright: ignore[reportUnknownArgumentType]
        )
    ).first()

    now = _utcnow_naive()

    if not token:
        raise HTTPException(status_code=401, detail="Invalid or expired code")

    expires_at = (
        token.expires_at.replace(tzinfo=None)
        if token.expires_at.tzinfo is not None
        else token.expires_at
    )
    if expires_at < now:
        raise HTTPException(status_code=401, detail="Invalid or expired code")

    if token.attempts >= MAX_OTP_ATTEMPTS:
        token.used_at = now
        session.add(token)
        session.commit()
        raise HTTPException(status_code=401, detail="Invalid or expired code")

    if _hash_otp(body.code) != token.code_hash:
        token.attempts += 1
        if token.attempts >= MAX_OTP_ATTEMPTS:
            token.used_at = now
        session.add(token)
        session.commit()
        raise HTTPException(status_code=401, detail="Invalid or expired code")

    user.email_verified_at = now
    token.used_at = now
    session.add(user)
    session.add(token)
    session.commit()

    return VerifyEmailResponse(verified=True, message="Email verified successfully")


@router.post("/resend-verification")
async def resend_verification(
    body: ResendVerificationRequest, session: Session = Depends(get_session)
) -> dict[str, str]:
    """Generate and send a new OTP code. Anti-enumeration: same response regardless of email."""
    message = "If an account exists and is unverified, a new code has been sent."

    if not resend_rate_limiter.is_allowed(body.email):
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={
                "Retry-After": str(resend_rate_limiter.get_retry_after(body.email))
            },
        )

    resend_rate_limiter.record_attempt(body.email)

    user = session.exec(
        select(UserDB).where(UserDB.email == body.email)
    ).first()
    if not user or user.email_verified_at is not None:
        return {"message": message}

    now = _utcnow_naive()
    active_tokens = session.exec(
        select(EmailVerificationTokenDB).where(
            EmailVerificationTokenDB.user_id == user.id,
            _as_column(cast(object, EmailVerificationTokenDB.used_at)).is_(None),
        )
    ).all()
    for t in active_tokens:
        t.used_at = now
        session.add(t)
    session.commit()

    await _create_and_send_otp(user, session)

    return {"message": message}


@router.post("/forgot-password")
async def forgot_password(
    body: ForgotPasswordRequest, session: Session = Depends(get_session)
) -> dict[str, str]:
    user = session.exec(
        select(UserDB).where(UserDB.email == body.email)
    ).first()

    if not user:
        return {
            "message": "If an account exists with that email, a reset link has been sent."
        }

    token = secrets.token_hex(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(hours=RESET_TOKEN_EXPIRY_HOURS)

    reset_token = PasswordResetTokenDB(
        user_id=user.id,
        token_hash=token_hash,
        expires_at=expires_at,
    )
    session.add(reset_token)
    session.commit()

    base_url = validate_frontend_url(
        os.environ.get("FRONTEND_URL", "http://localhost:3000")
    )
    reset_url = f"{base_url}/reset-password?token={token}"
    logger.info("Password reset requested for %s", body.email)
    logger.info("Reset URL: %s", reset_url)

    if user.email:
        html_body, text_body = render_password_reset_email(reset_url, user.name)
        try:
            await get_email_service().send(
                to=user.email,
                subject="Reset your password",
                html=html_body,
                text=text_body,
            )
        except EmailSendError:
            logger.warning("Failed to send password reset email to %s", body.email)

    return {
        "message": "If an account exists with that email, a reset link has been sent."
    }


@router.post("/reset-password")
def reset_password(
    body: ResetPasswordRequest, session: Session = Depends(get_session)
) -> dict[str, str]:
    token_hash = hashlib.sha256(body.token.encode()).hexdigest()
    reset_token = session.exec(
        select(PasswordResetTokenDB).where(
            PasswordResetTokenDB.token_hash == token_hash
        )
    ).first()

    if not reset_token:
        raise HTTPException(status_code=401, detail="Invalid or expired reset token")

    if reset_token.used_at is not None:
        raise HTTPException(status_code=401, detail="Token already used")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    expires_at = (
        reset_token.expires_at.replace(tzinfo=None)
        if reset_token.expires_at.tzinfo is not None
        else reset_token.expires_at
    )
    if expires_at < now:
        raise HTTPException(status_code=401, detail="Token expired")

    error = validate_password_strength(body.new_password)
    if error:
        raise HTTPException(status_code=422, detail=error)

    user = session.exec(
        select(UserDB).where(UserDB.id == reset_token.user_id)
    ).first()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired reset token")

    user.password_hash = hash_password(body.new_password)
    reset_token.used_at = now

    other_tokens = session.exec(
        select(PasswordResetTokenDB).where(
            PasswordResetTokenDB.user_id == user.id,
            PasswordResetTokenDB.id != reset_token.id,
        )
    ).all()
    for t in other_tokens:
        session.delete(t)

    session.add(user)
    session.add(reset_token)
    session.commit()

    return {"message": "Password reset successfully"}


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    user = session.exec(
        select(UserDB).where(UserDB.id == user_id)
    ).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    error = validate_password_strength(body.new_password)
    if error:
        raise HTTPException(status_code=422, detail=error)

    user.password_hash = hash_password(body.new_password)
    session.add(user)
    session.commit()

    invalidate_user_sessions(session, user_id)

    return {"message": "Password changed successfully"}


@router.post("/sign-out-everywhere")
def sign_out_everywhere(
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    """Invalidate all sessions for the current user. Requires re-authentication."""
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    invalidate_user_sessions(session, user_id)
    return {"message": "All sessions invalidated. Please sign in again."}


@router.get("/users", response_model=ListUsersResponse)
def list_users(request: Request, session: Session = Depends(get_session)):
    """List all users. Admin only."""
    admin = _require_admin(request, session)
    _ = admin
    users = session.exec(
        select(UserDB).order_by(
            _as_column(cast(object, UserDB.created_at))
        )
    ).all()
    return ListUsersResponse(users=[_user_to_response(u) for u in users])


@router.post("/users", response_model=UserResponse)
def invite_user(
    body: InviteUserRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Create a new user. Admin only."""
    _ = _require_admin(request, session)

    error = validate_password_strength(body.password)
    if error:
        raise HTTPException(status_code=422, detail=error)

    existing = session.exec(
        select(UserDB).where(UserDB.email == body.email)
    ).first()
    if existing:
        raise HTTPException(
            status_code=409, detail="A user with this email already exists"
        )

    user = UserDB(
        email=body.email,
        name=body.name,
        password_hash=hash_password(body.password),
        is_admin=False,
        is_active=True,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return _user_to_response(user)


@router.patch("/users/{user_id}", response_model=UserResponse)
def update_user(
    user_id: str,
    body: UpdateUserRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Update user role/name/active status. Admin only."""
    admin = _require_admin(request, session)

    user = session.get(UserDB, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if body.is_admin is False and user.id == admin.id:
        raise HTTPException(
            status_code=403, detail="Cannot remove your own admin role"
        )

    if body.name is not None:
        user.name = body.name
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    if body.is_active is not None:
        user.is_active = body.is_active

    session.add(user)
    session.commit()
    session.refresh(user)
    return _user_to_response(user)


@router.delete("/users/{user_id}")
def deactivate_user(
    user_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Deactivate a user (soft delete). Admin only. Cannot deactivate self."""
    admin = _require_admin(request, session)

    if user_id == admin.id:
        raise HTTPException(
            status_code=403, detail="Cannot deactivate your own account"
        )

    user = session.get(UserDB, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.is_active = False
    session.add(user)
    session.commit()

    invalidate_user_sessions(session, user_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Project invitation preview + acceptance (SPEC-127)
# ---------------------------------------------------------------------------
# These endpoints are intentionally public for preview/create-account
# (the invitee may not have a session yet) and signed-in-only for the
# existing-account acceptance path. They never touch ``UserDB.is_admin``.


@router.get("/invitations/preview", response_model=InvitationTokenPreviewResponse)
def preview_invitation(
    token: str,
    session: Session = Depends(get_session),
) -> InvitationTokenPreviewResponse:
    """Public preview of an invitation token.

    Reveals project/email/role metadata only when the token is still
    valid. Invalid/expired/revoked/accepted tokens all return a generic
    reason without leaking which one applied.
    """
    return preview_invitation_token(session, token)


@router.post("/invitations/accept/create-account")
def accept_invitation_create_account_endpoint(
    body: AcceptInvitationCreateAccountRequest,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    """Accept an invitation by creating a brand-new account.

    Creates the user (no admin privileges), attaches the project
    membership at the invited role, and marks the invitation accepted.
    The frontend is expected to sign the user in afterward using the
    credentials it just collected.
    """
    membership, invitation = accept_invitation_create_account(
        session,
        raw_token=body.token,
        name=body.name,
        password=body.password,
    )
    _ = membership
    return {"status": "accepted", "project_id": invitation.project_id}


@router.post("/invitations/accept/existing-account")
def accept_invitation_existing_account_endpoint(
    body: AcceptInvitationExistingAccountRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    """Accept an invitation onto the signed-in user's account.

    Requires an authenticated session. The signed-in email must match
    the invitation email exactly after normalization; any mismatch
    yields ``409`` and does not consume the token.
    """
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    membership, invitation = accept_invitation_existing_account(
        session,
        raw_token=body.token,
        accepting_user_id=user_id,
    )
    _ = membership
    return {"status": "accepted", "project_id": invitation.project_id}
