# pyright: reportCallInDefaultInitializer=false

"""
API Key management endpoints for SDK authentication.

Provides CRUD operations for API keys: create, list, revoke, rotate.
Keys are SHA256 hashed in storage and only shown once at creation time.
"""

import hashlib
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel import Session, select

from ..auth import verify_password
from ..auth.api_key_auth import generate_key_pair
from ..auth.api_key_cache import (
    api_key_cache,
    cache_key_for_bearer_public,
    cache_key_for_legacy,
)
from ..auth.deps import require_api_key_scope
from ..auth.rate_limit import LoginRateLimiter
from ..db import get_session
from ..models.db import ApiKeyDB, UserDB
from ..models.schemas import (
    ApiKeyBootstrapRequest,
    ApiKeyCreate,
    ApiKeyCreateResponse,
    ApiKeyResponse,
    ApiKeyRotateResponse,
)
from ..services.demo_workspace import require_project_not_demo
from ..services.project_memberships import require_project_role_or_legacy

router = APIRouter(prefix="/v1", tags=["api-keys"])

VALID_SCOPES = {"full", "ingest"}

_bootstrap_rate_limiter = LoginRateLimiter(max_attempts=5, window_seconds=60)


def _generate_legacy_api_key() -> tuple[str, str, str]:
    """Generate a legacy single-key token (for backward-compat endpoints like bootstrap)."""
    import secrets

    raw = secrets.token_hex(24)
    full_key = f"sk-{raw}"
    prefix = full_key[:8]
    hashed = hashlib.sha256(full_key.encode()).hexdigest()
    return full_key, prefix, hashed


def mint_legacy_key(
    session: Session,
    *,
    name: str,
    project: str,
    user_id: str,
    scope: str,
) -> tuple[ApiKeyDB, str]:
    """Generate, persist, and return a legacy single-key ``sk-…`` token.

    Shared by ``POST /v1/api-keys/bootstrap`` (existing CLI login flow) and
    ``POST /v1/projects/bootstrap`` (first-project creation). Hashes the key
    with SHA256 in storage and returns the row plus the plaintext key (shown
    to the caller exactly once).
    """
    full_key, prefix, hashed_key = _generate_legacy_api_key()
    api_key = ApiKeyDB(
        name=name,
        prefix=prefix,
        hashed_key=hashed_key,
        project=project,
        created_by=user_id,
        scope=scope,
    )
    session.add(api_key)
    session.commit()
    session.refresh(api_key)
    return api_key, full_key


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None) if hasattr(request, "state") else None
    if user_id:
        return str(user_id)
    raise HTTPException(status_code=401, detail="Authentication required")


def _parse_expires_at(expires_at_str: str | None) -> datetime | None:
    """Parse an ISO datetime string and validate it's in the future.

    Returns None if expires_at_str is None.
    Raises HTTPException(422) if the datetime is in the past.
    """
    if expires_at_str is None:
        return None
    try:
        parsed = datetime.fromisoformat(expires_at_str)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid expires_at format")
    now = datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed <= now:
        raise HTTPException(status_code=422, detail="Expiry must be in the future")
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _validate_scope(scope: str) -> str:
    """Validate the scope is one of the allowed values."""
    if scope not in VALID_SCOPES:
        raise HTTPException(status_code=422, detail="Invalid scope")
    return scope


def _invalidate_cache_for_key(api_key: ApiKeyDB) -> None:
    """Invalidate cache entries keyed off the current DB record.

    Call BEFORE deleting or mutating the record. The Basic-auth cache entry
    (``basic:{pk}:{sk_hash}``) cannot be reconstructed without the plaintext
    secret, so it is left to expire naturally (max 5 min). The Bearer public
    and legacy entries are always invalidated.
    """
    if api_key.hashed_key:
        api_key_cache.invalidate(cache_key_for_legacy(api_key.hashed_key))
    if api_key.public_key:
        api_key_cache.invalidate(cache_key_for_bearer_public(api_key.public_key))


@router.post("/api-keys", response_model=ApiKeyCreateResponse)
def create_api_key(
    body: ApiKeyCreate,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """
    Create a new API key pair (SPEC-092 two-key model).

    Generates a public key (pk-apo-<uuid>) and secret key (sk-apo-<uuid>).
    The secret key is shown once in the response; only its hash is stored.
    The public key is always visible in the key list.
    """
    user_id = _get_user_id(request)
    scope = _validate_scope(body.scope)
    expires_at = _parse_expires_at(body.expires_at)

    require_project_not_demo(body.project)
    # SPEC-122: API key creation requires admin role on the project.
    # Legacy projects (no ProjectDB row) are tolerated via the legacy
    # fallback so SDK bootstrap flows keep working.
    _ = require_project_role_or_legacy(
        session, body.project, user_id, minimum_role="admin"
    )

    public_key, secret_key, hashed_secret_key, display_secret_key = generate_key_pair()

    api_key = ApiKeyDB(
        name=body.name,
        prefix=public_key[:8],
        public_key=public_key,
        hashed_secret_key=hashed_secret_key,
        display_secret_key=display_secret_key,
        project=body.project,
        created_by=user_id,
        scope=scope,
        expires_at=expires_at,
    )
    session.add(api_key)
    session.commit()
    session.refresh(api_key)

    return ApiKeyCreateResponse(
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        project=api_key.project,
        created_by=api_key.created_by,
        scope=api_key.scope,
        created_at=api_key.created_at.isoformat(),
        last_used_at=api_key.last_used_at.isoformat() if api_key.last_used_at else None,
        expires_at=api_key.expires_at.isoformat() if api_key.expires_at else None,
        public_key=public_key,
        secret_key=secret_key,
        display_secret_key=display_secret_key,
    )


@router.get("/api-keys", response_model=list[ApiKeyResponse])
def list_api_keys(
    request: Request,
    project: str | None = Query(default=None),
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """
    List all API keys for the current user.
    Optionally filtered by project.
    Returns the public key and masked secret, never the full secret key.
    """
    user_id = _get_user_id(request)

    # SPEC-122: API key inventory is admin-scoped per the spec ("API
    # keys are managed by project admins/owners"). Ordinary members
    # must not enumerate keys for a project, even read-only.
    from ..services.project_memberships import (
        list_projects_with_minimum_role,
        require_project_role_or_legacy,
    )

    if project:
        # Project-scoped query: caller must be admin/owner (or legacy
        # owner of an ad-hoc project) to see any keys at all.
        _ = require_project_role_or_legacy(
            session, project, user_id, minimum_role="admin"
        )
        statement = select(ApiKeyDB).where(
            ApiKeyDB.project == project,
        )
    else:
        # Unscoped query: only return keys for projects where the user
        # has admin/owner role, plus any legacy ad-hoc keys they
        # created directly (no ProjectDB row, no memberships).
        admin_project_ids = set(
            list_projects_with_minimum_role(
                session, user_id, minimum_role="admin"
            )
        )
        statement = select(ApiKeyDB)
        if admin_project_ids:
            statement = statement.where(
                (ApiKeyDB.project.in_(admin_project_ids))  # pyright: ignore[reportAttributeAccessIssue]
                | (ApiKeyDB.created_by == user_id)
            )
        else:
            # No admin role anywhere — only legacy keys they created.
            statement = statement.where(ApiKeyDB.created_by == user_id)
    keys = session.exec(statement).all()

    return [
        ApiKeyResponse(
            id=k.id,
            name=k.name,
            prefix=k.prefix,
            project=k.project,
            created_by=k.created_by,
            scope=k.scope,
            created_at=k.created_at.isoformat(),
            last_used_at=k.last_used_at.isoformat() if k.last_used_at else None,
            expires_at=k.expires_at.isoformat() if k.expires_at else None,
            public_key=k.public_key,
            display_secret_key=k.display_secret_key or None,
        )
        for k in keys
    ]


@router.delete("/api-keys/{key_id}")
def revoke_api_key(
    key_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """
    Revoke (delete) an API key.
    Only the creator or admin can revoke a key.
    """
    user_id = _get_user_id(request)
    api_key = session.get(ApiKeyDB, key_id)

    if not api_key:
        raise HTTPException(status_code=404, detail="API key not found")

    require_project_not_demo(api_key.project)

    # SPEC-122: API key revocation requires admin role on the project.
    # The legacy ``request.state.is_admin`` check was dead code (the
    # middleware never set that attribute); it is replaced by the
    # membership check. Legacy projects (no ProjectDB row) tolerate the
    # creator as implicit owner.
    membership = require_project_role_or_legacy(
        session, api_key.project, user_id, minimum_role="admin"
    )
    is_legacy = membership.id.startswith("legacy-")
    if api_key.created_by != user_id and is_legacy:
        # Legacy mode: only the creator can revoke their own keys.
        raise HTTPException(status_code=403, detail="Not authorized to revoke this key")

    _invalidate_cache_for_key(api_key)
    session.delete(api_key)
    session.commit()
    return {"ok": True}


@router.post("/api-keys/{key_id}/rotate", response_model=ApiKeyRotateResponse)
def rotate_api_key(
    key_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """
    Rotate an API key: generates a new public/secret key pair and invalidates the old one.

    Legacy single keys are upgraded to the two-key model on rotation:
    the old ``hashed_key`` is cleared and replaced with ``public_key`` + ``hashed_secret_key``.
    The key ID, name, project, scope, and created_by all stay the same.
    Only the creator or admin can rotate a key.
    """
    user_id = _get_user_id(request)
    api_key = session.get(ApiKeyDB, key_id)

    if not api_key:
        raise HTTPException(status_code=404, detail="API key not found")

    require_project_not_demo(api_key.project)

    # SPEC-122: API key rotation requires admin role on the project
    # (replaces dead ``request.state.is_admin`` code path).
    membership = require_project_role_or_legacy(
        session, api_key.project, user_id, minimum_role="admin"
    )
    is_legacy = membership.id.startswith("legacy-")
    if api_key.created_by != user_id and is_legacy:
        raise HTTPException(status_code=403, detail="Not authorized to rotate this key")

    # Invalidate cache for the OLD public_key/hashed_key BEFORE mutating the record.
    _invalidate_cache_for_key(api_key)

    public_key, secret_key, hashed_secret_key, display_secret_key = generate_key_pair()

    api_key.public_key = public_key
    api_key.hashed_secret_key = hashed_secret_key
    api_key.display_secret_key = display_secret_key
    api_key.prefix = public_key[:8]
    api_key.hashed_key = None  # Clear legacy key (upgrade to pair)
    session.add(api_key)
    session.commit()

    return ApiKeyRotateResponse(
        id=api_key.id,
        public_key=public_key,
        secret_key=secret_key,
        message="Key rotated successfully. The old key is no longer valid.",
    )


def validate_api_key(token: str, session: Session) -> ApiKeyDB | None:
    """Validate an API key token by SHA256 hash lookup."""
    hashed = hashlib.sha256(token.encode()).hexdigest()
    statement = select(ApiKeyDB).where(ApiKeyDB.hashed_key == hashed)
    return session.exec(statement).first()


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/api-keys/bootstrap", response_model=ApiKeyCreateResponse)
def bootstrap_api_key(
    body: ApiKeyBootstrapRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """
    Mint an API key from email + password credentials.

    Purpose: lets `apo login` obtain a long-lived API key on first run,
    without requiring the user to copy a key out of the dashboard UI.

    Protected by the same rate limiter as `/auth/verify-password`.
    """
    ip = _get_client_ip(request)

    if not _bootstrap_rate_limiter.is_allowed(ip):
        retry_after = _bootstrap_rate_limiter.get_retry_after(ip)
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts",
            headers={"Retry-After": str(retry_after)},
        )

    _bootstrap_rate_limiter.record_attempt(ip)

    user = session.exec(select(UserDB).where(UserDB.email == body.email)).first()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    scope = _validate_scope(body.scope)

    require_project_not_demo(body.project)
    # SPEC-122: SDK bootstrap allows any project member to mint a key
    # for the project they belong to. Legacy projects (no ProjectDB
    # row) are tolerated so existing SDK workflows keep working.
    _ = require_project_role_or_legacy(
        session, body.project, user.id, minimum_role="member"
    )

    api_key, full_key = mint_legacy_key(
        session,
        name=body.name,
        project=body.project,
        user_id=user.id,
        scope=scope,
    )

    return ApiKeyCreateResponse(
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        project=api_key.project,
        created_by=api_key.created_by,
        scope=api_key.scope,
        created_at=api_key.created_at.isoformat(),
        last_used_at=api_key.last_used_at.isoformat() if api_key.last_used_at else None,
        expires_at=api_key.expires_at.isoformat() if api_key.expires_at else None,
        key=full_key,
    )
