"""Idempotent first-user provisioning from INIT_USER_* environment variables.

On startup, if no users exist in the database and both ``INIT_USER_EMAIL``
and ``INIT_USER_PASSWORD`` are set, an admin user is created automatically.
This enables headless Docker / CI deployments without manual UI setup.
"""

import logging
import os

from sqlmodel import Session, select

from .auth import hash_password, validate_password_strength
from .models.db import UserDB

logger = logging.getLogger(__name__)


def bootstrap_initial_user(session: Session) -> None:
    """Create first admin user from INIT_USER_* env vars if no users exist.

    Idempotent: if any user already exists, returns immediately.
    Never raises — errors are logged and the startup continues.
    """
    try:
        existing = session.exec(select(UserDB)).first()
    except Exception:
        logger.exception("Failed to query users during bootstrap")
        return

    if existing is not None:
        logger.info("Initial user already exists, skipping bootstrap")
        return

    email = os.environ.get("INIT_USER_EMAIL", "").strip()
    password = os.environ.get("INIT_USER_PASSWORD", "")
    name = os.environ.get("INIT_USER_NAME", "Admin").strip()

    if not email and not password:
        return

    if not email or not password:
        logger.warning(
            "Both INIT_USER_EMAIL and INIT_USER_PASSWORD must be set for bootstrap"
        )
        return

    error = validate_password_strength(password)
    if error is not None:
        logger.error("Bootstrap skipped — weak password: %s", error)
        return

    try:
        user = UserDB(
            email=email.lower(),
            name=name,
            password_hash=hash_password(password),
            is_admin=True,
        )
        session.add(user)
        session.commit()
        logger.info("Bootstrapped initial admin user: %s", email)
    except Exception:
        logger.exception("Failed to create bootstrap user")
        session.rollback()
