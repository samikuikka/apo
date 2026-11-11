"""The email-verification gate every password-based entry point shares.

Sign-in (``/auth/verify-password``) and the two CLI bootstrap endpoints
all turn an email and password into access. They must agree on whether an
account still owes its verification code, or the stricter one is walked
around through the others.
"""

from __future__ import annotations

from fastapi import HTTPException

from ..models.db import UserDB


def require_verified_email(user: UserDB, *, required_for_everyone: bool = False) -> None:
    """403 ``EMAIL_NOT_VERIFIED`` when the account must verify and has not.

    An account owes verification when it carries
    ``requires_email_verification`` (created from a self-serve invitation)
    or when the caller applies the installation-wide flag through
    ``required_for_everyone``. A NULL ``email_verified_at`` alone never
    blocks: accounts older than the gate have it and must keep working.
    """
    if user.email_verified_at is not None:
        return
    if user.requires_email_verification or required_for_everyone:
        raise HTTPException(
            status_code=403,
            detail={"message": "Email verification required", "code": "EMAIL_NOT_VERIFIED"},
        )


__all__ = ["require_verified_email"]
