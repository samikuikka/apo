# pyright: reportAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownVariableType=false, reportUnusedParameter=false

"""Authorization on the /v1/admin/* instance-maintenance routes.

Two accepted credentials: the operator's ADMIN_API_KEY (ops tooling) and an
authenticated installation-admin session (the dashboard's system page, whose
calls arrive through the frontend rewrite with only the session cookie).
"""

from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.auth import hash_password
from apo.models.db import UserDB


def _make_user(session: Session, *, is_admin: bool) -> UserDB:
    user = UserDB(
        email=f"{"admin" if is_admin else "plain"}-{uuid4().hex[:8]}@test.com",
        name="Test User",
        password_hash=hash_password("SecretPass123"),
        is_admin=is_admin,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


class TestAdminMaintenanceAuth:
    def test_admin_session_authorizes_without_admin_key(
        self, client: TestClient, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session, is_admin=True)
        authed = make_authed_client(user.id, session)
        resp = authed.get("/v1/admin/stats")
        assert resp.status_code == 200

    def test_non_admin_session_is_rejected(
        self, client: TestClient, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session, is_admin=False)
        authed = make_authed_client(user.id, session, is_admin=False)
        resp = authed.get("/v1/admin/stats")
        assert resp.status_code == 401

    def test_deactivated_admin_session_is_rejected(
        self, client: TestClient, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session, is_admin=True)
        user.is_active = False
        session.add(user)
        session.commit()

        authed = make_authed_client(user.id, session)
        resp = authed.get("/v1/admin/stats")
        assert resp.status_code == 401

    def test_admin_key_authorizes_without_session(self, client: TestClient) -> None:
        with patch("apo.routes.admin.ADMIN_API_KEY", "test-admin-key"):
            resp = client.get(
                "/v1/admin/stats", headers={"x-admin-key": "test-admin-key"}
            )
        assert resp.status_code == 200

    def test_wrong_admin_key_is_rejected(self, client: TestClient) -> None:
        with patch("apo.routes.admin.ADMIN_API_KEY", "test-admin-key"):
            resp = client.get(
                "/v1/admin/stats", headers={"x-admin-key": "wrong-key"}
            )
        assert resp.status_code == 401

    def test_no_credentials_is_rejected(self, client: TestClient) -> None:
        resp = client.get("/v1/admin/stats")
        assert resp.status_code == 401

    def test_admin_key_unconfigured_fails_closed(self, client: TestClient) -> None:
        with patch("apo.routes.admin.ADMIN_API_KEY", ""):
            resp = client.get(
                "/v1/admin/stats", headers={"x-admin-key": ""}
            )
        assert resp.status_code == 401
