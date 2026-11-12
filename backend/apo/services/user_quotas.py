"""Per-user quota policy: span-quota precedence and creation count caps.

The three ``users`` columns (daily_span_quota, max_projects, max_api_keys)
are per-account overrides set by an installation admin. This module is
the single owner of their semantics so the ingest guardrails and the
creation routes cannot drift apart: ``effective_daily_span_quota``
resolves a per-user override against the APO_USER_DAILY_SPAN_QUOTA
installation default, and the two ``enforce_*`` helpers raise 403 when
the account already holds its cap of live rows.

The creation caps default to small numbers rather than unlimited
(APO_DEFAULT_MAX_API_KEYS_PER_USER and APO_DEFAULT_MAX_PROJECTS_PER_USER,
5 each; 0 = unlimited). Every per-identity limit elsewhere (request
budget, read throttle, per-key span quota) multiplies by the number of
keys and projects one account may mint, so an unlimited default made
those limits meaningless. A NULL column takes the installation default;
a set column always wins, so an admin can raise, lower, or freeze (0)
any one account.

Denials stay 403 with a plain-string detail, and carry the numbers as
X-RateLimit headers for clients that want them. They deliberately do
NOT adopt the daily quotas' 429 block: released CLIs answer every 429
with "Too many attempts. Try again in a few minutes.", and a creation
cap only lifts when the user revokes a row or an admin raises the cap,
so telling them to wait would send them into a retry loop that cannot
succeed.

The count caps are checked then inserted without locking: two concurrent
creations can both pass and overshoot the cap by one. That is accepted;
the caps are an anti-abuse backstop, not an exact invariant.
"""

from __future__ import annotations

import os
from typing import cast

from fastapi import HTTPException
from sqlalchemy import func
from sqlmodel import Session, select

from ..models.db import ApiKeyDB, ProjectMembershipDB, UserDB
from ..models.schemas import UpdateUserRequest


def user_daily_span_quota() -> int:
    """Account-level daily span cap; 0/unset = off.

    Read per call (not import time) so a restart picks up new values and
    tests can monkeypatch it without module reloads.
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


def default_max_api_keys() -> int:
    """Installation default for the per-account API-key cap; 0 = unlimited.

    Read per call (not import time) so a restart picks up new values and
    tests can monkeypatch it without module reloads.
    """
    return _env_cap("APO_DEFAULT_MAX_API_KEYS_PER_USER", _DEFAULT_MAX_API_KEYS)


def default_max_projects() -> int:
    """Installation default for the per-account owned-project cap; 0 = unlimited."""
    return _env_cap("APO_DEFAULT_MAX_PROJECTS_PER_USER", _DEFAULT_MAX_PROJECTS)


def enforce_api_key_count_limit(session: Session, user_id: str) -> None:
    """Raise 403 when the account already holds its cap of API keys.

    Revocation hard-deletes key rows, so COUNT(api_keys.created_by) is
    the live fleet and a revoked key frees its slot on the next mint.
    The cap is the account's column when set, else the installation
    default. Runs before the insert so a denied mint writes nothing.
    """
    user = session.get(UserDB, user_id)
    if user is None:
        return
    limit = _resolve_cap(user.max_api_keys, default_max_api_keys())
    if limit is None:
        return
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
            headers={
                "X-RateLimit-Limit": str(limit),
                "X-RateLimit-Used": str(in_use),
            },
        )


def enforce_project_count_limit(session: Session, user_id: str) -> None:
    """Raise 403 when the account already owns its cap of projects.

    Ownership is COUNT(project_memberships WHERE role='owner'); leaving a
    project frees its slot. The cap is the account's column when set,
    else the installation default. Runs before the insert so a denied
    create writes nothing.
    """
    user = session.get(UserDB, user_id)
    if user is None:
        return
    limit = _resolve_cap(user.max_projects, default_max_projects())
    if limit is None:
        return
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
            headers={
                "X-RateLimit-Limit": str(limit),
                "X-RateLimit-Used": str(owned),
            },
        )


_QUOTA_FIELDS = ("daily_span_quota", "max_projects", "max_api_keys")


def apply_quota_updates(user: UserDB, body: UpdateUserRequest) -> None:
    """Apply the admin PATCH's tri-state quota fields to ``user``.

    Absent fields (detected via ``exclude_unset``) leave the column
    unchanged; an explicit ``null`` clears the per-user policy; a value
    sets it. Negative values raise 400. Mutates ``user`` in place; the
    caller owns the commit.
    """
    updates = body.model_dump(exclude_unset=True)
    for field in _QUOTA_FIELDS:
        if field not in updates:
            continue
        value = cast("int | None", updates[field])
        if value is not None and value < 0:
            raise HTTPException(
                status_code=400,
                detail=f"{field} must be null or a non-negative integer",
            )
        setattr(user, field, value)


def load_default_creation_caps() -> tuple[int, int]:
    """Validate the installation-default creation caps: (keys, projects).

    Called at app construction so an invalid value stops startup naming
    the variable, instead of failing the first key or project creation.
    """
    return default_max_api_keys(), default_max_projects()


def _resolve_cap(override: int | None, installation_default: int) -> int | None:
    """Resolve a creation cap; ``None`` = unlimited.

    A per-user override always wins, and unlike the span quota its 0 is a
    real cap (creation frozen), not "lift the cap". Without an override
    the installation default applies, where 0 = unlimited.
    """
    if override is not None:
        return override
    return installation_default if installation_default > 0 else None


def _env_cap(name: str, default: int) -> int:
    """Read one installation-default cap from the environment.

    Missing means ``default``. Present empty, non-integer, or negative
    raises :class:`ValueError` naming only ``name``. A typo must not be
    read as 0: that would silently lift an anti-abuse cap for every
    account.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    text = raw.strip()
    try:
        value = int(text)
    except ValueError:
        raise ValueError(
            f"{name} must be a non-negative base-10 integer (got {text!r})"
        ) from None
    if value < 0:
        raise ValueError(f"{name} must be a non-negative integer (got {value})")
    return value


_DEFAULT_MAX_API_KEYS = 5
_DEFAULT_MAX_PROJECTS = 5


__all__ = [
    "apply_quota_updates",
    "default_max_api_keys",
    "default_max_projects",
    "effective_daily_span_quota",
    "enforce_api_key_count_limit",
    "enforce_project_count_limit",
    "load_default_creation_caps",
    "user_daily_span_quota",
]
