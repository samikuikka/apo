# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

import time

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.auth import (
    _dummy_hash,
    hash_password,
    validate_password_strength,
    verify_password,
)
from apo.models.db import UserDB


class TestValidatePasswordStrength:
    def test_strong_password(self) -> None:
        assert validate_password_strength("MyPass123") is None

    def test_minimum_valid(self) -> None:
        assert validate_password_strength("Pass1234") is None

    def test_too_short(self) -> None:
        assert validate_password_strength("short") is not None

    def test_no_numbers(self) -> None:
        result = validate_password_strength("onlylettershere")
        assert result is not None
        assert "number" in result.lower()

    def test_no_letters(self) -> None:
        result = validate_password_strength("12345678")
        assert result is not None
        assert "letter" in result.lower()

    def test_empty_string(self) -> None:
        result = validate_password_strength("")
        assert result is not None
        assert "8 characters" in result

    def test_unicode_with_numbers(self) -> None:
        assert validate_password_strength("Pässwörd123") is None

    def test_long_password(self) -> None:
        long_pw = "a" * 80 + "1"
        assert validate_password_strength(long_pw) is None

    def test_exactly_8_chars_with_letter_and_number(self) -> None:
        assert validate_password_strength("abcd1234") is None


class TestHashAndVerifyPassword:
    def test_hash_and_verify_roundtrip(self) -> None:
        pw = "MySecret123"
        hashed = hash_password(pw)
        assert verify_password(pw, hashed) is True
        assert verify_password("wrong", hashed) is False

    def test_dummy_hash_exists(self) -> None:
        assert _dummy_hash is not None
        assert _dummy_hash.startswith("$2")

    def test_dummy_hash_verifies(self) -> None:
        assert verify_password("dummy-timing-safe-value", _dummy_hash) is True
        assert verify_password("wrong-password", _dummy_hash) is False


class TestHasUsers:
    def test_no_users(self, client: TestClient) -> None:
        resp = client.get("/auth/has-users")
        assert resp.status_code == 200
        assert resp.json() == {"has_users": False}

    def test_with_users(self, client: TestClient) -> None:
        client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )
        resp = client.get("/auth/has-users")
        assert resp.status_code == 200
        assert resp.json() == {"has_users": True}


class TestSetup:
    def test_successful_setup(self, client: TestClient, session: Session) -> None:
        resp = client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "id" in data

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.email == "admin@test.com"
        assert user.name == "Admin"
        # SPEC-122: the first user is no longer auto-admin. Product
        # authorization comes from project memberships.
        assert user.is_admin is False
        assert verify_password("SecurePass123", user.password_hash)

    def test_weak_password_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "short", "name": "Admin"},
        )
        assert resp.status_code == 422
        assert "8 characters" in resp.json()["detail"]

    def test_no_numbers_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "onlylettershere", "name": "Admin"},
        )
        assert resp.status_code == 422

    def test_no_letters_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "12345678", "name": "Admin"},
        )
        assert resp.status_code == 422

    def test_second_setup_creates_non_admin_user(self, client: TestClient, session: Session) -> None:
        client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )
        resp = client.post(
            "/auth/setup",
            json={"email": "other@test.com", "password": "SecurePass456", "name": "Other"},
        )
        assert resp.status_code == 200

        admin = session.exec(
            select(UserDB).where(UserDB.email == "admin@test.com")
        ).first()
        other = session.exec(
            select(UserDB).where(UserDB.email == "other@test.com")
        ).first()
        assert admin is not None
        assert other is not None
        # SPEC-122: neither user is auto-admin.
        assert admin.is_admin is False
        assert other.is_admin is False

    def test_duplicate_email_rejected(self, client: TestClient) -> None:
        client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )
        resp = client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass456", "name": "Admin Again"},
        )
        assert resp.status_code == 409
        assert "already exists" in resp.json()["detail"].lower()


class TestVerifyPassword:
    def _setup_user(self, client: TestClient) -> None:
        client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )

    def test_correct_credentials(self, client: TestClient) -> None:
        self._setup_user(client)
        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "admin@test.com"
        assert data["name"] == "Admin"
        assert "id" in data

    def test_wrong_password(self, client: TestClient) -> None:
        self._setup_user(client)
        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "WrongPass999"},
        )
        assert resp.status_code == 401

    def test_nonexistent_email(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/verify-password",
            json={"email": "nobody@test.com", "password": "Whatever123"},
        )
        assert resp.status_code == 401

    def test_timing_safe_login(self, client: TestClient) -> None:
        self._setup_user(client)

        start = time.monotonic()
        client.post(
            "/auth/verify-password",
            json={"email": "nobody@test.com", "password": "Whatever123"},
        )
        nonexistent_time = time.monotonic() - start

        start = time.monotonic()
        client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "WrongPass999"},
        )
        wrong_pw_time = time.monotonic() - start

        assert abs(nonexistent_time - wrong_pw_time) < 0.15
