"""Installation initialization service.

The sole authority for setup eligibility and initial-user claims. Uses a
durable singleton row (``InstallationStateDB``) as the source of truth — not
the User count. An atomic database compare-and-set ensures exactly one
initial-user claim can succeed, even under concurrency.
"""

# pyright: reportDeprecated=false, reportUnusedCallResult=false

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import update
from sqlmodel import Session, col, select

from ..auth import hash_password
from ..models.db import InstallationStateDB, UserDB

INSTALLATION_STATE_ID = "installation"

# The demo fixture writes this placeholder as the password hash of its inert
# author account (``demo@apo.invalid``): display data that activity rows can
# point at, but never a credential. Such rows must not count as "this
# installation has users".
_PLACEHOLDER_PASSWORD_HASH = "!"


@dataclass(frozen=True)
class InstallationSetupStatus:
    """Durable initialization eligibility plus current User presence."""

    has_users: bool
    setup_available: bool


class InstallationAlreadyInitializedError(RuntimeError):
    """Raised when an initial-user claim is attempted after initialization."""


def _earliest_credential_user(session: Session) -> UserDB | None:
    """Earliest user row that represents a real, human-created account.

    Every fresh demo-enabled installation boots with the fixture's inert
    author row already present. Before this filter existed, the singleton
    backfill fired on that row and permanently closed both first-admin
    paths (/auth/setup 409, INIT_USER bootstrap no-op) on fresh volumes.
    Real accounts count regardless of active status — deactivating the
    last real admin must not reopen setup to whoever visits next.
    """
    return session.exec(
        select(UserDB)
        .where(col(UserDB.password_hash) != _PLACEHOLDER_PASSWORD_HASH)
        .order_by(col(UserDB.created_at))
        .limit(1)
    ).first()


def _fixture_claimed_installation(
    state: InstallationStateDB, session: Session
) -> bool:
    """Whether a pre-fix backfill recorded the fixture placeholder as the
    initial user while no credential user exists."""
    if state.initial_user_id is None:
        return False
    recorded = session.get(UserDB, state.initial_user_id)
    if recorded is None or recorded.password_hash != _PLACEHOLDER_PASSWORD_HASH:
        return False
    return _earliest_credential_user(session) is None


def _ensure_singleton(session: Session) -> InstallationStateDB:
    """Ensure the singleton row exists and return it.

    ``initialized_at`` backfills from the earliest *credential* user (see
    ``_earliest_credential_user``) — the demo fixture's placeholder author
    never claims the installation. A state that an older backfill claimed
    for the placeholder is repaired while no credential user exists.
    """
    state = session.get(InstallationStateDB, INSTALLATION_STATE_ID)
    if state is None:
        earliest = _earliest_credential_user(session)
        if earliest is not None:
            state = InstallationStateDB(
                id=INSTALLATION_STATE_ID,
                initialized_at=earliest.created_at,
                initial_user_id=earliest.id,
            )
        else:
            state = InstallationStateDB(id=INSTALLATION_STATE_ID)
        session.add(state)
        session.commit()
        session.refresh(state)
    elif state.initialized_at is None:
        # Repair a pre-backfill singleton: if credential users exist, mark
        # initialized.
        earliest = _earliest_credential_user(session)
        if earliest is not None:
            state.initialized_at = earliest.created_at
            state.initial_user_id = earliest.id
            session.add(state)
            session.commit()
            session.refresh(state)
    elif _fixture_claimed_installation(state, session):
        # The pre-fix backfill recorded the demo fixture's placeholder as
        # the initial user, which closed every real first-admin path. With
        # no credential user in the database the installation is factually
        # unclaimed — reopen it so /auth/setup and the INIT_USER bootstrap
        # work again.
        state.initialized_at = None
        state.initial_user_id = None
        session.add(state)
        session.commit()
        session.refresh(state)
    return state


def get_installation_setup_status(session: Session) -> InstallationSetupStatus:
    """Return durable initialization eligibility plus current User presence."""
    state = _ensure_singleton(session)
    has_users = _earliest_credential_user(session) is not None
    setup_available = state.initialized_at is None
    return InstallationSetupStatus(has_users=has_users, setup_available=setup_available)


def claim_initial_user(
    session: Session,
    *,
    email: str,
    name: str,
    password: str,
    is_instance_admin: bool,
) -> UserDB:
    """Atomically initialize the installation and create exactly one User.

    Performs a database-level compare-and-set against the singleton row: the
    UPDATE succeeds only when ``initialized_at IS NULL``. If zero rows are
    affected, another caller won the race — raise immediately and roll back
    the User insert.

    Raises :class:`InstallationAlreadyInitializedError` when the installation
    has already been claimed. Raises ``ValueError`` for invalid input (empty
    email, etc.) without consuming initialization.
    """
    normalized_email = email.strip().lower()
    if not normalized_email:
        raise ValueError("email is required")

    _ensure_singleton(session)

    # Create the User first (flush to get the ID, but don't commit yet).
    user = UserDB(
        email=normalized_email,
        name=name.strip() if name else "",
        password_hash=hash_password(password),
        is_admin=is_instance_admin,
    )
    session.add(user)
    session.flush()

    # Atomic compare-and-set: UPDATE ... WHERE initialized_at IS NULL.
    now = datetime.now(timezone.utc)
    stmt = (
        update(InstallationStateDB)
        .where(
            col(InstallationStateDB.id) == INSTALLATION_STATE_ID,
            col(InstallationStateDB.initialized_at).is_(None),
        )
        .values(initialized_at=now, initial_user_id=user.id)
    )
    result = session.execute(stmt)

    if getattr(result, "rowcount", 0) == 0:
        # Another caller already claimed initialization.
        session.rollback()
        raise InstallationAlreadyInitializedError(
            "Installation has already been initialized"
        )

    session.commit()
    session.refresh(user)
    return user


def ensure_initial_user_is_instance_admin(session: Session) -> bool:
    """Repair (#152) for installs initialized without an installation admin.

    The durable singleton records who initialized the installation, and the
    invariant (enforced by ``claim_initial_user`` and the fixed
    ``/auth/setup``) is that this user is the instance admin — otherwise
    Settings -> Hosted access and the invitation API are unreachable. An
    install whose first user was created before that invariant existed (the
    old ``/auth/setup`` wrote ``is_admin=False``) can have nobody with the
    role at all; restore it from the record.

    Returns True when a promotion was written. The initial user keeps the
    role permanently: there is no supported way to run an installation with
    zero admins, and this user is the durable designated one.
    """
    state = _ensure_singleton(session)
    if state.initialized_at is None or state.initial_user_id is None:
        return False
    user = session.get(UserDB, state.initial_user_id)
    if user is None or user.is_admin:
        return False
    user.is_admin = True
    session.add(user)
    session.commit()
    return True
