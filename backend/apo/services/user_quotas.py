"""Per-user quota policy: span-quota precedence and creation count caps.

The three ``users`` columns (daily_span_quota, max_projects, max_api_keys)
are set per account by an installation admin. This module is the single
owner of their semantics so the ingest guardrails and the creation routes
cannot drift apart: ``effective_daily_span_quota`` resolves a per-user
override against the APO_USER_DAILY_SPAN_QUOTA installation default, and
the two ``enforce_*`` helpers raise 403 when the account already holds
its cap of live rows. Details are plain strings because the CLI renders
them verbatim.
"""

from __future__ import annotations

import os

from fastapi import HTTPException
from sqlalchemy import func
from sqlmodel import Session, select

from ..models.db import ApiKeyDB, ProjectMembershipDB, UserDB


def user_daily_span_quota() -> int:
    """Account-level daily span cap; 0/unset = off.

    Read per call (not import time) so operators can flip it with a
    restart-free env change on the next request and tests can monkeypatch
    it without module reloads.
    """
    try:
        return int(os.environ.get("APO_USER_DAILY_SPAN_QUOTA", "0"))
    except ValueError:
        return 0


def effective_daily_span_quota(override: int | None) -> int | None:
    """Resolve the account daily span limit; ``None`` = unlimited.

    A per-user override wins over the environment: ``0`` explicitly lifts
    the cap (a trusted account stays unlimited under an
    installation-wide default) and ``N > 0`` caps at ``N``. Without an
    override the env default applies (0/unset = unlimited).
    """
    if override is not None:
        return override if override > 0 else None
    env_quota = user_daily_span_quota()
    return env_quota if env_quota > 0 else None


def enforce_api_key_count_limit(session: Session, user_id: str) -> None:
    """Raise 403 when the account already holds its cap of API keys.

    Revocation hard-deletes key rows, so COUNT(api_keys.created_by) is
    the live fleet and a revoked key frees its slot on the next mint.
    NULL = unlimited. Runs before the insert so a denied mint writes
    nothing.
    """
    user = session.get(UserDB, user_id)
    if user is None or user.max_api_keys is None:
        return
    limit = user.max_api_keys
    in_use = session.exec(
        select(func.count()).select_from(ApiKeyDB).where(ApiKeyDB.created_by == user_id)
    ).one()
    if in_use >= limit:
        raise HTTPException(
            status_code=403,
            detail=(
                f"API key limit reached for this account: {in_use} in use, "
                f"max {limit}. Revoke a key or contact an administrator."
            ),
        )


def enforce_project_count_limit(session: Session, user_id: str) -> None:
    """Raise 403 when the account already owns its cap of projects.

    Ownership is COUNT(project_memberships WHERE role='owner'); leaving a
    project frees its slot. NULL = unlimited. Runs before the insert so
    a denied create writes nothing.
    """
    user = session.get(UserDB, user_id)
    if user is None or user.max_projects is None:
        return
    limit = user.max_projects
    owned = session.exec(
        select(func.count())
        .select_from(ProjectMembershipDB)
        .where(
            ProjectMembershipDB.user_id == user_id,
            ProjectMembershipDB.role == "owner",
        )
    ).one()
    if owned >= limit:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Project limit reached for this account: {owned} owned, "
                f"max {limit}. Contact an administrator to raise the limit."
            ),
        )


__all__ = [
    "effective_daily_span_quota",
    "enforce_api_key_count_limit",
    "enforce_project_count_limit",
    "user_daily_span_quota",
]
