# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.auth import hash_password, invalidate_user_sessions
from apo.auth.middleware import _extract_token_iat, _is_before
from apo.models.db import UserDB


def _create_user(
    session: Session,
    email: str = "user@test.com",
    password: str = "SecurePass123",
    is_admin: bool = False,
) -> UserDB:
    user = UserDB(
        email=email,
        name="Test User",
        password_hash=hash_password(password),
        is_admin=is_admin,
        is_active=True,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _setup_admin_and_authed(
    client: TestClient, session: Session, make_authed_client: Any
) -> tuple[TestClient, str]:
    client.post(
        "/auth/setup",
        json={"email": "admin@test.com", "password": "AdminPass123", "name": "Admin"},
    )
    admin = session.exec(select(UserDB)).first()
    assert admin is not None
    # SPEC-122: /auth/setup no longer auto-grants is_admin. The global
    # /auth/users admin endpoints still check UserDB.is_admin, so set
    # it directly for these legacy admin-flow tests.
    admin.is_admin = True
    session.add(admin)
    session.commit()
    return make_authed_client(admin.id, session), admin.id


class TestExtractTokenIat:
    def test_valid_int_iat(self) -> None:
        payload: dict[str, object] = {"iat": 1700000000}
        result = _extract_token_iat(payload)
        assert result is not None
        assert result == datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)

    def test_valid_float_iat(self) -> None:
        payload: dict[str, object] = {"iat": 1700000000.5}
        result = _extract_token_iat(payload)
        assert result is not None
        assert result.year == 2023

    def test_valid_string_iat(self) -> None:
        payload: dict[str, object] = {"iat": "1700000000"}
        result = _extract_token_iat(payload)
        assert result is not None
        assert result == datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)

    def test_missing_iat_returns_none(self) -> None:
        payload: dict[str, object] = {"sub": "user-123"}
        result = _extract_token_iat(payload)
        assert result is None

    def test_unparseable_string_iat_returns_none(self) -> None:
        payload: dict[str, object] = {"iat": "not-a-number"}
        result = _extract_token_iat(payload)
        assert result is None

    def test_unexpected_type_iat_returns_none(self) -> None:
        payload: dict[str, object] = {"iat": [1, 2, 3]}
        result = _extract_token_iat(payload)
        assert result is None


class TestIsBefore:
    def test_iat_before_cutoff_returns_true(self) -> None:
        iat = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        cutoff = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        assert _is_before(iat, cutoff) is True

    def test_iat_after_cutoff_returns_false(self) -> None:
        iat = datetime(2024, 6, 1, 12, 0, 1, tzinfo=timezone.utc)
        cutoff = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        assert _is_before(iat, cutoff) is False

    def test_iat_equal_to_cutoff_returns_false(self) -> None:
        """Token issued at exactly the cutoff time is valid (>= comparison)."""
        cutoff_dt = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        assert _is_before(cutoff_dt, cutoff_dt) is False

    def test_naive_and_aware_comparison(self) -> None:
        iat = datetime(2024, 1, 1, 12, 0, 0)
        cutoff = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        assert _is_before(iat, cutoff) is True


class TestInvalidateUserSessions:
    def test_sets_token_invalid_before(
        self, session: Session
    ) -> None:
        user = _create_user(session)
        assert user.token_invalid_before is None

        before = datetime.now(timezone.utc).replace(tzinfo=None)
        invalidate_user_sessions(session, user.id)

        session.refresh(user)
        assert user.token_invalid_before is not None
        stored = user.token_invalid_before
        if stored.tzinfo is not None:
            stored = stored.replace(tzinfo=None)
        assert stored >= before

    def test_nonexistent_user_no_error(
        self, session: Session
    ) -> None:
        invalidate_user_sessions(session, "nonexistent-id")

    def test_multiple_invalidations_update_timestamp(
        self, session: Session
    ) -> None:
        user = _create_user(session)

        invalidate_user_sessions(session, user.id)
        session.refresh(user)
        first = user.token_invalid_before
        assert first is not None

        # Small delay to ensure different timestamp
        import time
        time.sleep(0.01)

        invalidate_user_sessions(session, user.id)
        session.refresh(user)
        second = user.token_invalid_before
        assert second is not None
        assert second >= first


class TestSignOutEverywhereEndpoint:
    def test_sign_out_everywhere_sets_timestamp(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, admin_id = _setup_admin_and_authed(client, session, make_authed_client)

        resp = authed.post("/auth/sign-out-everywhere")
        assert resp.status_code == 200
        assert "invalidated" in resp.json()["message"].lower()

        user = session.get(UserDB, admin_id)
        assert user is not None
        assert user.token_invalid_before is not None

    def test_unauthenticated_returns_401(self, client: TestClient) -> None:
        resp = client.post("/auth/sign-out-everywhere")
        assert resp.status_code == 401


class TestPasswordChangeInvalidation:
    def test_change_password_sets_token_invalid_before(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, admin_id = _setup_admin_and_authed(client, session, make_authed_client)

        resp = authed.post(
            "/auth/change-password",
            json={"current_password": "AdminPass123", "new_password": "NewPass456"},
        )
        assert resp.status_code == 200

        user = session.get(UserDB, admin_id)
        assert user is not None
        assert user.token_invalid_before is not None

    def test_wrong_current_password_no_invalidation(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, admin_id = _setup_admin_and_authed(client, session, make_authed_client)

        resp = authed.post(
            "/auth/change-password",
            json={"current_password": "WrongPass999", "new_password": "NewPass456"},
        )
        assert resp.status_code == 401

        user = session.get(UserDB, admin_id)
        assert user is not None
        assert user.token_invalid_before is None


class TestDeactivationInvalidation:
    def test_deactivate_sets_token_invalid_before(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_and_authed(client, session, make_authed_client)

        invite_resp = authed.post(
            "/auth/users",
            json={"email": "member@test.com", "name": "Member", "password": "MemberPass123"},
        )
        member_id = invite_resp.json()["id"]

        resp = authed.delete(f"/auth/users/{member_id}")
        assert resp.status_code == 200

        user = session.get(UserDB, member_id)
        assert user is not None
        assert user.is_active is False
        assert user.token_invalid_before is not None


class TestBackwardCompatibility:
    def test_new_user_has_none_token_invalid_before(
        self, session: Session
    ) -> None:
        user = _create_user(session)
        assert user.token_invalid_before is None

    def test_user_with_none_passes_is_before_check(
        self, session: Session
    ) -> None:
        """When token_invalid_before is None, the middleware skips the check entirely."""
        user = _create_user(session)
        assert user.token_invalid_before is None
        # Simulate middleware logic: None → skip check → pass
        iat = datetime.now(timezone.utc)
        if user.token_invalid_before is not None:
            token_iat = _extract_token_iat({"iat": iat.timestamp()})
            if token_iat is not None and _is_before(token_iat, user.token_invalid_before):
                pass  # would be rejected
        # Reaching here means the token passes (backward compatible)


class TestNewLoginAfterInvalidation:
    def test_new_iat_after_cutoff_passes(self) -> None:
        """Simulates: user logs in after invalidation, new JWT has iat > cutoff."""
        cutoff = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        new_iat = datetime(2024, 6, 1, 12, 30, 0, tzinfo=timezone.utc)
        assert _is_before(new_iat, cutoff) is False

    def test_old_iat_before_cutoff_fails(self) -> None:
        """Simulates: old JWT issued before cutoff is rejected."""
        cutoff = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        old_iat = datetime(2024, 5, 31, 12, 0, 0, tzinfo=timezone.utc)
        assert _is_before(old_iat, cutoff) is True
