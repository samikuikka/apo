"""Installation Administrator guard.

The canonical guard for installation-administrator surfaces: the
``/auth/users`` management routes (list, invite, update, deactivate)
and Hosted Access Invitation administration. Only an authenticated,
active ``UserDB.is_admin`` User may perform these operations.

Authority rules:

- **browser session** authority is accepted;
- **Project API keys** and executor capability credentials
  (``service_token`` / ``attempt_token``) are rejected even when their
  creator is an administrator: installation authority never rides on a
  Project-scoped credential;
- the guard never produces Project membership or Project access.
"""

from __future__ import annotations

from fastapi import HTTPException, Request
from sqlmodel import Session

from ..models.db import UserDB

# Credential kinds that can never carry installation-administrator
# authority, regardless of who created them.
_REJECTED_CREDENTIAL_KINDS = frozenset(
    {"api_key", "service_token", "attempt_token"}
)


def require_installation_admin(request: Request, session: Session) -> UserDB:
    """Require an active authenticated User with ``is_admin=True``.

    Raises 401 when no user is authenticated, 403 when the credential
    kind is not allowed, the User is inactive, or the User is not an
    administrator.
    """
    auth_method = getattr(request.state, "auth_method", None)
    if auth_method in _REJECTED_CREDENTIAL_KINDS:
        raise HTTPException(
            status_code=403,
            detail="Installation administrator authority requires a browser session",
        )

    user_id = getattr(request.state, "user_id", None)
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    user = session.get(UserDB, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated")
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


__all__ = ["require_installation_admin"]
