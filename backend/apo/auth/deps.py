# pyright: reportCallInDefaultInitializer=false, reportDeprecated=false

"""Shared authentication and authorization dependencies for FastAPI routes.

These deps rely on AuthMiddleware having authenticated the request and set
`request.state.user_id`. They perform fresh DB lookups so role/active status
is always current (JWT claims can go stale until token expiry).

SPEC-122 introduces project-scoped authorization via
:mod:`apo.services.project_memberships`. Those helpers are re-exported
here so routes can import everything auth-related from one module.
"""

from collections.abc import Callable
from typing import cast

from fastapi import Depends, HTTPException, Request
from sqlmodel import Session

from ..db import get_session
from ..models.db import UserDB
from ..services.project_memberships import (
    DEMO_PROJECT_ID,
    compute_permissions,
    get_project_membership,
    require_project_member,
    require_project_role,
)

__all__ = [
    "DEMO_PROJECT_ID",
    "get_current_user",
    "get_project_membership",
    "require_admin",
    "require_api_key_scope",
    "require_project_member",
    "require_project_role",
    "compute_permissions",
]


def get_current_user(
    request: Request, session: Session = Depends(get_session)
) -> UserDB:
    """Return the authenticated user, or raise 401."""
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    user = session.get(UserDB, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


def require_admin(user: UserDB = Depends(get_current_user)) -> UserDB:
    """Return the authenticated admin user, or raise 403.

    Note (SPEC-122): ``is_admin`` is reserved for instance-maintenance
    flows guarded by ``ADMIN_API_KEY``. Product routes must use the
    project-role helpers (``require_project_role`` etc.) instead.
    """
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def require_api_key_scope(
    *allowed_scopes: str,
) -> Callable[[Request], None]:
    """FastAPI dependency factory: rejects API key requests with insufficient scope.

    Cookie-authenticated (dashboard) requests always bypass this check.
    Only API-key-authenticated requests are checked.
    """

    def checker(request: Request) -> None:
        auth_method = getattr(request.state, "auth_method", None)
        if auth_method != "api_key":
            return
        scope = getattr(request.state, "api_key_scope", "full")
        if scope not in allowed_scopes:
            raise HTTPException(
                status_code=403, detail="API key scope insufficient"
            )

    return checker
