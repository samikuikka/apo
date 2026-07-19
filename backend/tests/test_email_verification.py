# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedParameter=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportAttributeAccessIssue=false, reportUnusedFunction=false

from collections.abc import Generator
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import EmailVerificationTokenDB, UserDB
from apo.routes.auth import _hash_otp, resend_rate_limiter
from apo.services.email import EmailService


# ---- Helpers / fixtures ----


def _reset_resend_limiter() -> None:
    resend_rate_limiter._attempts.clear()


@pytest.fixture(autouse=True)
def _clean_resend_limiter() -> Generator[None, None, None]:
    _reset_resend_limiter()
    yield
    _reset_resend_limiter()


@pytest.fixture
def email_verification_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Enable AUTH_EMAIL_VERIFICATION_REQUIRED for the test."""
    monkeypatch.setenv("AUTH_EMAIL_VERIFICATION_REQUIRED", "true")


@pytest.fixture
def mock_email_service():
    """Mock the email service so no real emails are sent during tests."""
    mock_service = AsyncMock(spec=EmailService)
    mock_service.send = AsyncMock()
    with patch(
        "apo.routes.auth.get_email_service", return_value=mock_service
    ):
        yield mock_service


def _setup_with_verification(client: TestClient) -> dict[str, object]:
    """POST /auth/setup with the verification flag on; asserts and returns JSON."""
    resp = client.post(
        "/auth/setup",
        json={
            "email": "admin@test.com",
            "password": "SecurePass123",
            "name": "Admin",
        },
    )
    assert resp.status_code == 200
    return resp.json()


# ---- Happy path tests ----


class TestVerifiedSignup:
    """Spec test cases 1-3: verified signup completes, flag off, resend."""

    def test_setup_returns_verification_required_when_flag_on(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        data = _setup_with_verification(client)
        assert data["status"] == "verification_required"
        assert data["email"] == "admin@test.com"

        mock_email_service.send.assert_called_once()
        call_kwargs = mock_email_service.send.call_args
        assert call_kwargs.kwargs["to"] == "admin@test.com"
        assert "verify" in call_kwargs.kwargs["subject"].lower()

    def test_user_created_with_unverified_email_when_flag_on(
        self,
        client: TestClient,
        session: Session,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        _setup_with_verification(client)

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.email_verified_at is None

        tokens = session.exec(select(EmailVerificationTokenDB)).all()
        assert len(tokens) == 1
        assert tokens[0].used_at is None
        assert tokens[0].attempts == 0

    def test_flag_off_setup_returns_ok(
        self,
        client: TestClient,
        session: Session,
        mock_email_service: AsyncMock,
    ) -> None:
        resp = client.post(
            "/auth/setup",
            json={
                "email": "admin@test.com",
                "password": "SecurePass123",
                "name": "Admin",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "id" in data
        mock_email_service.send.assert_not_called()

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.email_verified_at is not None

    def test_verify_email_completes_signup(
        self,
        client: TestClient,
        session: Session,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        with patch("apo.routes.auth._generate_otp", return_value="482915"):
            _setup_with_verification(client)

        resp = client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "482915"},
        )
        assert resp.status_code == 200
        assert resp.json()["verified"] is True

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.email_verified_at is not None

        login_resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert login_resp.status_code == 200

    def test_token_marked_used_after_verification(
        self,
        client: TestClient,
        session: Session,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        with patch("apo.routes.auth._generate_otp", return_value="334455"):
            _setup_with_verification(client)

        client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "334455"},
        )

        token = session.exec(select(EmailVerificationTokenDB)).first()
        assert token is not None
        assert token.used_at is not None


# ---- Error handling tests ----


class TestVerifyEmailErrors:
    """Spec test cases 4-6: expired OTP, too many attempts, login blocked."""

    def test_invalid_code_returns_401(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        _setup_with_verification(client)

        resp = client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "000000"},
        )
        assert resp.status_code == 401
        assert "Invalid or expired" in resp.json()["detail"]

    def test_expired_otp_rejected(
        self,
        client: TestClient,
        session: Session,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        _setup_with_verification(client)

        token = session.exec(select(EmailVerificationTokenDB)).first()
        assert token is not None
        token.expires_at = (
            datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)
        )
        session.add(token)
        session.commit()

        resp = client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "123456"},
        )
        assert resp.status_code == 401
        assert "Invalid or expired" in resp.json()["detail"]

    def test_too_many_attempts_invalidates_code(
        self,
        client: TestClient,
        session: Session,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        with patch("apo.routes.auth._generate_otp", return_value="789123"):
            _setup_with_verification(client)

        for _ in range(5):
            resp = client.post(
                "/auth/verify-email",
                json={"email": "admin@test.com", "code": "000000"},
            )
            assert resp.status_code == 401

        resp = client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "789123"},
        )
        assert resp.status_code == 401

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.email_verified_at is None

    def test_nonexistent_user_returns_401(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/verify-email",
            json={"email": "ghost@test.com", "code": "123456"},
        )
        assert resp.status_code == 401

    def test_already_verified_user_returns_success(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        with patch("apo.routes.auth._generate_otp", return_value="111222"):
            _setup_with_verification(client)
            client.post(
                "/auth/verify-email",
                json={"email": "admin@test.com", "code": "111222"},
            )

        resp = client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "111222"},
        )
        assert resp.status_code == 200
        assert resp.json()["verified"] is True

    def test_otp_stored_as_hash_not_plaintext(
        self,
        client: TestClient,
        session: Session,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        with patch("apo.routes.auth._generate_otp", return_value="654321"):
            _setup_with_verification(client)

        token = session.exec(select(EmailVerificationTokenDB)).first()
        assert token is not None
        assert token.code_hash == _hash_otp("654321")
        assert "654321" not in token.code_hash


# ---- Login gating tests ----


class TestLoginGating:
    """Spec test case 6 + edge case 9: login blocked, existing users blocked."""

    def test_login_blocked_for_unverified_user(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        _setup_with_verification(client)

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 403
        detail = resp.json()["detail"]
        assert isinstance(detail, dict)
        assert detail["code"] == "EMAIL_NOT_VERIFIED"

    def test_login_works_after_verification(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        with patch("apo.routes.auth._generate_otp", return_value="555666"):
            _setup_with_verification(client)

        client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "555666"},
        )

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 200

    def test_wrong_password_still_returns_401(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        _setup_with_verification(client)

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "WrongPass999"},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"

    def test_existing_users_blocked_when_flag_turns_on(
        self,
        client: TestClient,
        session: Session,
        mock_email_service: AsyncMock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client.post(
            "/auth/setup",
            json={
                "email": "admin@test.com",
                "password": "SecurePass123",
                "name": "Admin",
            },
        )

        user = session.exec(select(UserDB)).first()
        assert user is not None
        user.email_verified_at = None
        session.add(user)
        session.commit()

        monkeypatch.setenv("AUTH_EMAIL_VERIFICATION_REQUIRED", "true")

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 403
        detail = resp.json()["detail"]
        assert isinstance(detail, dict)
        assert detail["code"] == "EMAIL_NOT_VERIFIED"


# ---- Resend verification tests ----


class TestResendVerification:
    """Spec test case 3 + edge cases 7-8: resend, anti-enumeration, rate limit."""

    def test_resend_sends_new_code_and_invalidates_old(
        self,
        client: TestClient,
        session: Session,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        with patch(
            "apo.routes.auth._generate_otp",
            side_effect=["111111", "222222"],
        ):
            _setup_with_verification(client)
            assert mock_email_service.send.call_count == 1

            resp = client.post(
                "/auth/resend-verification",
                json={"email": "admin@test.com"},
            )
            assert resp.status_code == 200
            assert "new code has been sent" in resp.json()["message"]
            assert mock_email_service.send.call_count == 2

        tokens = session.exec(select(EmailVerificationTokenDB)).all()
        assert len(tokens) == 2
        assert tokens[0].used_at is not None
        assert tokens[1].used_at is None

        resp = client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "111111"},
        )
        assert resp.status_code == 401

        resp = client.post(
            "/auth/verify-email",
            json={"email": "admin@test.com", "code": "222222"},
        )
        assert resp.status_code == 200
        assert resp.json()["verified"] is True

    def test_resend_anti_enumeration(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        _setup_with_verification(client)

        resp_existing = client.post(
            "/auth/resend-verification",
            json={"email": "admin@test.com"},
        )
        resp_nonexistent = client.post(
            "/auth/resend-verification",
            json={"email": "nobody@test.com"},
        )

        assert resp_existing.status_code == 200
        assert resp_nonexistent.status_code == 200
        assert resp_existing.json() == resp_nonexistent.json()

    def test_resend_rate_limited(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        _setup_with_verification(client)

        first = client.post(
            "/auth/resend-verification",
            json={"email": "admin@test.com"},
        )
        assert first.status_code == 200

        second = client.post(
            "/auth/resend-verification",
            json={"email": "admin@test.com"},
        )
        assert second.status_code == 429
        assert "Retry-After" in second.headers

    def test_resend_for_verified_user_sends_nothing(
        self,
        client: TestClient,
        email_verification_enabled: None,
        mock_email_service: AsyncMock,
    ) -> None:
        with patch("apo.routes.auth._generate_otp", return_value="999888"):
            _setup_with_verification(client)
            client.post(
                "/auth/verify-email",
                json={"email": "admin@test.com", "code": "999888"},
            )

        send_count_before = mock_email_service.send.call_count
        resp = client.post(
            "/auth/resend-verification",
            json={"email": "admin@test.com"},
        )
        assert resp.status_code == 200
        assert "new code has been sent" in resp.json()["message"]
        assert mock_email_service.send.call_count == send_count_before
