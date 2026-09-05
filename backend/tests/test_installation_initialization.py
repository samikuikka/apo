# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedImport=false
# pyright: reportAttributeAccessIssue=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportMissingParameterType=false

"""Acceptance tests: installation initialization (tests 1-7)."""

from __future__ import annotations

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool


@pytest.fixture
def fresh_session():
    """Isolated in-memory SQLite with InstallationStateDB available."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


class TestInstallationSetupStatus:
    """Tests 1-3: fresh exposes setup; initialized stays closed; full reset reopens."""

    def test_fresh_installation_exposes_setup(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import get_installation_setup_status

        status = get_installation_setup_status(fresh_session)
        assert status.has_users is False
        assert status.setup_available is True

    def test_initialized_stays_closed_after_user_deletion(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import (
            claim_initial_user,
            get_installation_setup_status,
        )
        from apo.models.db import UserDB

        # Claim the initial user.
        claim_initial_user(
            fresh_session, email="admin@test.com", name="Admin", password="a-strong-password-123", is_instance_admin=True
        )
        # Delete all users without clearing installation state.
        for u in fresh_session.exec(select(UserDB)).all():
            fresh_session.delete(u)
        fresh_session.commit()

        status = get_installation_setup_status(fresh_session)
        assert status.has_users is False
        assert status.setup_available is False

    def test_full_reset_reopens_setup(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import (
            claim_initial_user,
            get_installation_setup_status,
        )
        from apo.models.db import InstallationStateDB, UserDB

        claim_initial_user(
            fresh_session, email="admin@test.com", name="Admin", password="a-strong-password-123", is_instance_admin=True
        )

        # Simulate a full database reset — delete ALL data including users
        # and the singleton, as the explicit reset flow does.
        for u in fresh_session.exec(select(UserDB)).all():
            fresh_session.delete(u)
        state = fresh_session.get(InstallationStateDB, "installation")
        assert state is not None
        fresh_session.delete(state)
        fresh_session.commit()

        # A fresh database (no users, no singleton) reopens setup.
        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is True


class TestAtomicClaim:
    """Tests 4-5: concurrent claims; failed user creation doesn't consume init."""

    def test_concurrent_claim_only_one_succeeds(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import (
            InstallationAlreadyInitializedError,
            claim_initial_user,
        )

        claim_initial_user(
            fresh_session, email="first@test.com", name="First", password="a-strong-password-123", is_instance_admin=True
        )

        with pytest.raises(InstallationAlreadyInitializedError):
            claim_initial_user(
                fresh_session, email="second@test.com", name="Second", password="another-strong-pw-456", is_instance_admin=True
            )

    def test_failed_user_creation_does_not_consume_init(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import get_installation_setup_status

        # Force a failure by using an invalid email (empty after strip).
        # The claim should raise (not InstallationAlreadyInitializedError)
        # and setup should remain available.
        with pytest.raises(Exception):
            from apo.services.installation_initialization import claim_initial_user
            claim_initial_user(
                fresh_session, email="", name="Bad", password="a-strong-password-123", is_instance_admin=True
            )

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is True


class TestBootstrapIntegration:
    """Tests 6-7: bootstrap uses shared claim; initialized is no-op."""

    def test_bootstrap_claims_initial_user(self, fresh_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_initialization import get_installation_setup_status

        monkeypatch.setenv("INIT_USER_EMAIL", "bootstrap@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "a-strong-password-123")
        monkeypatch.setenv("INIT_USER_NAME", "Bootstrap")

        from apo.bootstrap import bootstrap_initial_user
        bootstrap_initial_user(fresh_session)

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is False
        assert status.has_users is True

    def test_initialized_bootstrap_is_noop(self, fresh_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_initialization import claim_initial_user, get_installation_setup_status

        # Initialize first.
        claim_initial_user(
            fresh_session, email="first@test.com", name="First", password="a-strong-password-123", is_instance_admin=True
        )

        # Delete all users (simulate edge case).
        from apo.models.db import UserDB
        for u in fresh_session.exec(select(UserDB)).all():
            fresh_session.delete(u)
        fresh_session.commit()

        # Bootstrap should NOT create a new user.
        monkeypatch.setenv("INIT_USER_EMAIL", "bootstrap@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "a-strong-password-123")
        from apo.bootstrap import bootstrap_initial_user
        bootstrap_initial_user(fresh_session)

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is False  # Still closed.
        assert status.has_users is False  # No user was created.


def _add_fixture_placeholder(session: Session) -> object:
    """Mimic the demo fixture's inert author row (demo@apo.invalid)."""
    from apo.models.db import UserDB

    user = UserDB(
        email="demo@apo.invalid",
        name="Apo Demo",
        password_hash="!",
        is_active=False,
        is_admin=False,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


class TestFixturePlaceholderDoesNotClaimInstallation:
    """The demo fixture's inert author row must never initialize the install.

    Every fresh demo-enabled volume boots with that row present; before the
    credential filter, the singleton backfill fired on it and permanently
    closed /auth/setup and the INIT_USER bootstrap."""

    def test_placeholder_only_install_keeps_setup_open(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import get_installation_setup_status

        _add_fixture_placeholder(fresh_session)
        status = get_installation_setup_status(fresh_session)
        assert status.has_users is False
        assert status.setup_available is True

    def test_claim_succeeds_with_placeholder_present(self, fresh_session: Session) -> None:
        from apo.services.installation_initialization import (
            claim_initial_user,
            get_installation_setup_status,
        )

        _add_fixture_placeholder(fresh_session)
        user = claim_initial_user(
            fresh_session,
            email="admin@test.com",
            name="Admin",
            password="a-strong-password-123",
            is_instance_admin=True,
        )
        assert user.is_admin is True

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is False
        assert status.has_users is True

    def test_mis_backfilled_installation_is_reopened(self, fresh_session: Session) -> None:
        """Old-bug state: the singleton was backfilled onto the placeholder."""
        from apo.models.db import InstallationStateDB
        from apo.services.installation_initialization import get_installation_setup_status

        placeholder = _add_fixture_placeholder(fresh_session)
        fresh_session.add(
            InstallationStateDB(
                id="installation",
                initialized_at=placeholder.created_at,
                initial_user_id=placeholder.id,
            )
        )
        fresh_session.commit()

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is True
        assert status.has_users is False

    def test_mis_backfill_with_credential_user_stays_closed(
        self, fresh_session: Session
    ) -> None:
        """Once any credential user exists, the recorded claim stands."""
        from apo.auth import hash_password
        from apo.models.db import InstallationStateDB, UserDB
        from apo.services.installation_initialization import get_installation_setup_status

        placeholder = _add_fixture_placeholder(fresh_session)
        fresh_session.add(
            InstallationStateDB(
                id="installation",
                initialized_at=placeholder.created_at,
                initial_user_id=placeholder.id,
            )
        )
        fresh_session.add(
            UserDB(
                email="real@test.com",
                name="Real",
                password_hash=hash_password("a-strong-password-123"),
            )
        )
        fresh_session.commit()

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is False
        assert status.has_users is True

    def test_deactivated_real_user_keeps_setup_closed(self, fresh_session: Session) -> None:
        """Deactivating the last real admin must not reopen setup."""
        from apo.services.installation_initialization import (
            claim_initial_user,
            get_installation_setup_status,
        )

        user = claim_initial_user(
            fresh_session,
            email="admin@test.com",
            name="Admin",
            password="a-strong-password-123",
            is_instance_admin=True,
        )
        user.is_active = False
        fresh_session.add(user)
        fresh_session.commit()

        status = get_installation_setup_status(fresh_session)
        assert status.setup_available is False

    def test_setup_endpoint_succeeds_with_fixture_placeholder(
        self, client, session  # type: ignore[no-untyped-def]
    ) -> None:
        from apo.models.db import UserDB

        session.add(
            UserDB(
                email="demo@apo.invalid",
                name="Apo Demo",
                password_hash="!",
                is_active=False,
                is_admin=False,
            )
        )
        session.commit()

        resp = client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )
        assert resp.status_code == 200

        resp = client.post(
            "/auth/setup",
            json={"email": "other@test.com", "password": "SecurePass123", "name": "Other"},
        )
        assert resp.status_code == 409
