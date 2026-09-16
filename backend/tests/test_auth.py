# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

import time
from statistics import median

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.auth import (
    _dummy_hash,
    hash_password,
    validate_password_strength,
    verify_password,
)
from apo.models.db import UserDB
from apo.services.installation_initialization import get_installation_setup_status


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
        # the response also carries setup_available; assert has_users
        # specifically rather than exact-equality on the whole payload.
        assert resp.json()["has_users"] is False

    def test_with_users(self, client: TestClient) -> None:
        client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )
        resp = client.get("/auth/has-users")
        assert resp.status_code == 200
        assert resp.json()["has_users"] is True


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
        # #152: the browser-setup user is the installation admin — without
        # one, Settings -> Hosted access is unreachable. Product
        # authorization still comes from project memberships.
        assert user.is_admin is True
        assert verify_password("SecurePass123", user.password_hash)
        # the atomic claim initialized the installation: setup is closed.
        assert get_installation_setup_status(session).setup_available is False

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

    def test_second_setup_rejected_after_initialization(
        self, client: TestClient, session: Session
    ) -> None:
        # #152: /auth/setup is first-installation only. Once claimed,
        # admission is invite-only — an open setup route would
        # let anyone create an account without an invitation.
        client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )
        resp = client.post(
            "/auth/setup",
            json={"email": "other@test.com", "password": "SecurePass456", "name": "Other"},
        )
        assert resp.status_code == 409
        assert "already been initialized" in resp.json()["detail"]

        users = session.exec(select(UserDB)).all()
        assert len(users) == 1, "no second user may be created through setup"

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
        # The first setup claimed the installation, so the initialization
        # guard rejects any second call — duplicate email included.
        assert "already been initialized" in resp.json()["detail"]


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
        # Unknown email must cost the same as a wrong password — both run one
        # bcrypt verification (unknown email against a dummy hash), otherwise
        # the response time becomes an account-enumeration oracle.
        #
        # A single wall-clock sample per path is untestable on shared CI
        # runners: one bcrypt op costs ~0.25s there and a scheduler hiccup on
        # either request skews the pair by more than the old 0.15s tolerance.
        # Each path is therefore sampled in both request orders (whichever
        # request runs second absorbs the runner's positional bias — pairing
        # both ways cancels it) and compared by median.
        self._setup_user(client)

        nonexistent_times: list[float] = []
        wrong_pw_times: list[float] = []
        for nonexistent_first in (True, False, False, True):
            requests = [
                ("nobody@test.com", "Whatever123"),
                ("admin@test.com", "WrongPass999"),
            ]
            if not nonexistent_first:
                requests.reverse()

            for email, password in requests:
                start = time.monotonic()
                client.post(
                    "/auth/verify-password",
                    json={"email": email, "password": password},
                )
                elapsed = time.monotonic() - start
                if email == "nobody@test.com":
                    nonexistent_times.append(elapsed)
                else:
                    wrong_pw_times.append(elapsed)

        nonexistent = median(nonexistent_times)
        wrong_pw = median(wrong_pw_times)
        # The tolerance must scale with bcrypt cost on the runner (an op can
        # exceed 0.4s on slow vCPUs), yet still catch the oracle everywhere:
        # a dropped dummy-hash check collapses one median to ~0s against a
        # full bcrypt op on the other, which no tolerance here can absorb.
        tolerance = max(0.15, 0.4 * min(nonexistent, wrong_pw))
        assert abs(nonexistent - wrong_pw) < tolerance
