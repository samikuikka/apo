# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

import hashlib
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, select
from typing import Any

from apo.auth import verify_password
from apo.models.db import PasswordResetTokenDB, UserDB


def _setup_user(client: TestClient) -> dict[str, Any]:
    resp = client.post(
        "/auth/setup",
        json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
    )
    assert resp.status_code == 200
    return resp.json()


class TestForgotPassword:
    def test_existing_email_returns_200(self, client: TestClient) -> None:
        _setup_user(client)
        resp = client.post(
            "/auth/forgot-password",
            json={"email": "admin@test.com"},
        )
        assert resp.status_code == 200
        assert "reset link has been sent" in resp.json()["message"]

    def test_nonexistent_email_returns_200(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/forgot-password",
            json={"email": "nobody@test.com"},
        )
        assert resp.status_code == 200
        assert "reset link has been sent" in resp.json()["message"]

    def test_creates_reset_token_for_existing_user(
        self, client: TestClient, session: Session
    ) -> None:
        _setup_user(client)
        client.post("/auth/forgot-password", json={"email": "admin@test.com"})

        tokens = session.exec(select(PasswordResetTokenDB)).all()
        assert len(tokens) == 1
        assert tokens[0].used_at is None
        expires = tokens[0].expires_at
        if expires.tzinfo is not None:
            expires = expires.replace(tzinfo=None)
        assert expires > datetime.now(timezone.utc).replace(tzinfo=None)

    def test_no_token_created_for_nonexistent_email(
        self, client: TestClient, session: Session
    ) -> None:
        client.post("/auth/forgot-password", json={"email": "ghost@test.com"})
        tokens = session.exec(select(PasswordResetTokenDB)).all()
        assert len(tokens) == 0

    def test_multiple_requests_create_multiple_tokens(
        self, client: TestClient, session: Session
    ) -> None:
        _setup_user(client)
        client.post("/auth/forgot-password", json={"email": "admin@test.com"})
        client.post("/auth/forgot-password", json={"email": "admin@test.com"})

        tokens = session.exec(select(PasswordResetTokenDB)).all()
        assert len(tokens) == 2

    def test_logs_reset_url(self, client: TestClient) -> None:
        _setup_user(client)
        with patch("apo.routes.auth.logger") as mock_logger:
            client.post("/auth/forgot-password", json={"email": "admin@test.com"})
            mock_logger.info.assert_called()
            log_calls = [str(call) for call in mock_logger.info.call_args_list]
            assert any("Reset URL" in c for c in log_calls)


class TestResetPassword:
    def _get_reset_token(
        self, client: TestClient, _session: Session
    ) -> tuple[str, str]:
        _setup_user(client)
        with patch("apo.routes.auth.logger") as mock_logger:
            client.post("/auth/forgot-password", json={"email": "admin@test.com"})
            for call in mock_logger.info.call_args_list:
                msg = str(call)
                if "Reset URL:" in msg:
                    url = msg.split("Reset URL: ")[-1].rstrip(")'")
                    token = url.split("token=")[-1]
                    return token, "admin@test.com"
        raise AssertionError("Reset URL not found in logs")

    def test_successful_reset(self, client: TestClient, session: Session) -> None:
        token, _ = self._get_reset_token(client, session)

        resp = client.post(
            "/auth/reset-password",
            json={"token": token, "new_password": "NewSecure456"},
        )
        assert resp.status_code == 200
        assert "successfully" in resp.json()["message"].lower()

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert verify_password("NewSecure456", user.password_hash)

    def test_can_login_with_new_password_after_reset(
        self, client: TestClient, session: Session
    ) -> None:
        token, _ = self._get_reset_token(client, session)
        client.post(
            "/auth/reset-password",
            json={"token": token, "new_password": "NewSecure456"},
        )

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "NewSecure456"},
        )
        assert resp.status_code == 200

    def test_old_password_no_longer_works_after_reset(
        self, client: TestClient, session: Session
    ) -> None:
        token, _ = self._get_reset_token(client, session)
        client.post(
            "/auth/reset-password",
            json={"token": token, "new_password": "NewSecure456"},
        )

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 401

    def test_invalid_token_returns_401(self, client: TestClient) -> None:
        _setup_user(client)
        resp = client.post(
            "/auth/reset-password",
            json={"token": "invalidtoken123", "new_password": "NewSecure456"},
        )
        assert resp.status_code == 401
        assert "Invalid or expired" in resp.json()["detail"]

    def test_expired_token_returns_401(
        self, client: TestClient, session: Session
    ) -> None:
        _setup_user(client)

        user = session.exec(select(UserDB)).first()
        assert user is not None

        expired_token = PasswordResetTokenDB(
            user_id=user.id,
            token_hash=hashlib.sha256(b"expired-token").hexdigest(),
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1),
        )
        session.add(expired_token)
        session.commit()

        resp = client.post(
            "/auth/reset-password",
            json={"token": "expired-token", "new_password": "NewSecure456"},
        )
        assert resp.status_code == 401
        assert "expired" in resp.json()["detail"].lower()

    def test_reused_token_returns_401(
        self, client: TestClient, session: Session
    ) -> None:
        token, _ = self._get_reset_token(client, session)

        client.post(
            "/auth/reset-password",
            json={"token": token, "new_password": "NewSecure456"},
        )

        resp = client.post(
            "/auth/reset-password",
            json={"token": token, "new_password": "AnotherPass789"},
        )
        assert resp.status_code == 401
        assert "already used" in resp.json()["detail"].lower()

    def test_weak_new_password_rejected(
        self, client: TestClient, session: Session
    ) -> None:
        token, _ = self._get_reset_token(client, session)

        resp = client.post(
            "/auth/reset-password",
            json={"token": token, "new_password": "short"},
        )
        assert resp.status_code == 422

    def test_token_marked_as_used_after_reset(
        self, client: TestClient, session: Session
    ) -> None:
        token, _ = self._get_reset_token(client, session)

        client.post(
            "/auth/reset-password",
            json={"token": token, "new_password": "NewSecure456"},
        )

        token_hash = hashlib.sha256(token.encode()).hexdigest()
        reset_token = session.exec(
            select(PasswordResetTokenDB).where(
                PasswordResetTokenDB.token_hash == token_hash
            )
        ).first()
        assert reset_token is not None
        assert reset_token.used_at is not None

    def test_other_tokens_deleted_on_reset(
        self, client: TestClient, session: Session
    ) -> None:
        _setup_user(client)
        client.post("/auth/forgot-password", json={"email": "admin@test.com"})
        client.post("/auth/forgot-password", json={"email": "admin@test.com"})

        all_tokens = session.exec(select(PasswordResetTokenDB)).all()
        assert len(all_tokens) == 2

        latest_token = ""
        with patch("apo.routes.auth.logger") as mock_logger:
            client.post("/auth/forgot-password", json={"email": "admin@test.com"})
            for call in mock_logger.info.call_args_list:
                msg = str(call)
                if "Reset URL:" in msg:
                    url = msg.split("Reset URL: ")[-1].rstrip(")'")
                    latest_token = url.split("token=")[-1]
                    break

        client.post(
            "/auth/reset-password",
            json={"token": latest_token, "new_password": "NewSecure456"},
        )

        remaining = session.exec(select(PasswordResetTokenDB)).all()
        assert len(remaining) == 1
        assert remaining[0].used_at is not None


class TestChangePassword:
    def _make_authenticated_client(
        self, user_id: str, session: Session
    ) -> TestClient:
        from starlette.middleware.base import BaseHTTPMiddleware
        from apo.api import app
        from apo.db import get_session

        class InjectUserMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                request.state.user_id = user_id
                return await call_next(request)

        new_app = FastAPI()
        new_app.include_router(app.router)
        new_app.add_middleware(InjectUserMiddleware)

        new_app.dependency_overrides[get_session] = lambda: session
        return TestClient(new_app)

    def test_successful_change(self, client: TestClient, session: Session) -> None:
        data = _setup_user(client)
        user_id = data["id"]

        user = session.exec(select(UserDB).where(UserDB.id == user_id)).first()
        assert user is not None

        authed = self._make_authenticated_client(user_id, session)
        resp = authed.post(
            "/auth/change-password",
            json={
                "current_password": "SecurePass123",
                "new_password": "NewSecure456",
            },
        )
        assert resp.status_code == 200
        assert "changed successfully" in resp.json()["message"].lower()

        session.refresh(user)
        assert verify_password("NewSecure456", user.password_hash)
        assert not verify_password("SecurePass123", user.password_hash)

    def test_wrong_current_password(self, client: TestClient, session: Session) -> None:
        data = _setup_user(client)
        authed = self._make_authenticated_client(data["id"], session)

        resp = authed.post(
            "/auth/change-password",
            json={
                "current_password": "WrongPass999",
                "new_password": "NewSecure456",
            },
        )
        assert resp.status_code == 401
        assert "incorrect" in resp.json()["detail"].lower()

    def test_weak_new_password_rejected(self, client: TestClient, session: Session) -> None:
        data = _setup_user(client)
        authed = self._make_authenticated_client(data["id"], session)

        resp = authed.post(
            "/auth/change-password",
            json={
                "current_password": "SecurePass123",
                "new_password": "short",
            },
        )
        assert resp.status_code == 422

    def test_unauthenticated_request(self, client: TestClient) -> None:
        _setup_user(client)

        resp = client.post(
            "/auth/change-password",
            json={
                "current_password": "SecurePass123",
                "new_password": "NewSecure456",
            },
        )
        assert resp.status_code == 401
        assert "authentication required" in resp.json()["detail"].lower()

    def test_nonexistent_user(self, client: TestClient, session: Session) -> None:
        _setup_user(client)
        authed = self._make_authenticated_client("nonexistent-user-id", session)

        resp = authed.post(
            "/auth/change-password",
            json={
                "current_password": "SecurePass123",
                "new_password": "NewSecure456",
            },
        )
        assert resp.status_code == 401
        assert "not found" in resp.json()["detail"].lower()
