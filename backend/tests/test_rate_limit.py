# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from apo.auth.rate_limit import LoginRateLimiter, login_rate_limiter


def _reset_rate_limiter() -> None:
    login_rate_limiter._attempts.clear()


class TestLoginRateLimiterIsAllowed:
    def test_allows_first_request(self) -> None:
        limiter = LoginRateLimiter()
        assert limiter.is_allowed("192.168.1.1") is True

    def test_allows_up_to_max_attempts(self) -> None:
        limiter = LoginRateLimiter()
        limiter.max_attempts = 3
        for _ in range(3):
            limiter.record_attempt("192.168.1.1")
        assert limiter.is_allowed("192.168.1.1") is False

    def test_blocks_after_max_exceeded(self) -> None:
        limiter = LoginRateLimiter()
        limiter.max_attempts = 3
        for _ in range(3):
            limiter.is_allowed("192.168.1.1")
            limiter.record_attempt("192.168.1.1")
        assert limiter.is_allowed("192.168.1.1") is False

    def test_different_ips_tracked_separately(self) -> None:
        limiter = LoginRateLimiter()
        limiter.max_attempts = 2
        limiter.record_attempt("1.1.1.1")
        limiter.record_attempt("1.1.1.1")
        assert limiter.is_allowed("1.1.1.1") is False
        assert limiter.is_allowed("2.2.2.2") is True

    def test_window_expiry_allows_new_attempts(self) -> None:
        limiter = LoginRateLimiter()
        limiter.max_attempts = 2
        limiter.window_seconds = 1

        limiter.record_attempt("1.1.1.1")
        limiter.record_attempt("1.1.1.1")
        assert limiter.is_allowed("1.1.1.1") is False

        time.sleep(1.1)
        assert limiter.is_allowed("1.1.1.1") is True

    def test_default_max_attempts_is_10(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            limiter = LoginRateLimiter()
            assert limiter.max_attempts == 10

    def test_default_window_is_300(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            limiter = LoginRateLimiter()
            assert limiter.window_seconds == 300

    def test_env_config_override(self) -> None:
        with patch.dict(
            "os.environ",
            {"AUTH_RATE_LIMIT_MAX_ATTEMPTS": "5", "AUTH_RATE_LIMIT_WINDOW_SECONDS": "60"},
        ):
            limiter = LoginRateLimiter()
            assert limiter.max_attempts == 5
            assert limiter.window_seconds == 60


class TestLoginRateLimiterGetRetryAfter:
    def test_returns_zero_when_no_attempts(self) -> None:
        limiter = LoginRateLimiter()
        assert limiter.get_retry_after("1.1.1.1") == 0

    def test_returns_seconds_until_oldest_expires(self) -> None:
        limiter = LoginRateLimiter()
        limiter.window_seconds = 60
        limiter.record_attempt("1.1.1.1")
        retry = limiter.get_retry_after("1.1.1.1")
        assert 1 <= retry <= 60

    def test_returns_zero_after_window_expires(self) -> None:
        limiter = LoginRateLimiter()
        limiter.window_seconds = 1
        limiter.record_attempt("1.1.1.1")
        time.sleep(1.1)
        assert limiter.get_retry_after("1.1.1.1") == 0


class TestLoginRateLimiterMemoryCap:
    def test_evicts_oldest_entry_when_over_cap(self) -> None:
        limiter = LoginRateLimiter()
        limiter.max_attempts = 100

        for i in range(10_001):
            key = f"1.2.3.{i}"
            limiter.record_attempt(key)
            limiter.is_allowed(key)

        assert len(limiter._attempts) <= 10_000

    def test_eviction_removes_oldest_key(self) -> None:
        limiter = LoginRateLimiter()
        limiter.max_attempts = 100

        limiter.record_attempt("oldest-key")
        time.sleep(0.01)

        for i in range(10_000):
            key = f"1.2.3.{i}"
            limiter.record_attempt(key)
            limiter.is_allowed(key)

        assert "oldest-key" not in limiter._attempts


class TestLoginRateLimiterRecordAttempt:
    def test_records_attempt_for_key(self) -> None:
        limiter = LoginRateLimiter()
        limiter.record_attempt("1.1.1.1")
        assert len(limiter._attempts["1.1.1.1"]) == 1

    def test_records_multiple_attempts(self) -> None:
        limiter = LoginRateLimiter()
        limiter.record_attempt("1.1.1.1")
        limiter.record_attempt("1.1.1.1")
        limiter.record_attempt("1.1.1.1")
        assert len(limiter._attempts["1.1.1.1"]) == 3


@pytest.fixture(autouse=True)
def _clean_rate_limiter():
    _reset_rate_limiter()
    yield
    _reset_rate_limiter()


class TestVerifyPasswordRateLimit:
    def _setup_user(self, client: TestClient) -> None:
        client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "SecurePass123", "name": "Admin"},
        )

    def test_returns_429_after_max_attempts(self, client: TestClient) -> None:
        self._setup_user(client)
        for _ in range(10):
            client.post(
                "/auth/verify-password",
                json={"email": "admin@test.com", "password": "WrongPass999"},
            )

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 429
        assert "Retry-After" in resp.headers
        assert "Too many login attempts" in resp.json()["detail"]

    def test_429_response_has_retry_after_header(self, client: TestClient) -> None:
        self._setup_user(client)
        for _ in range(10):
            client.post(
                "/auth/verify-password",
                json={"email": "admin@test.com", "password": "WrongPass999"},
            )

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "WrongPass999"},
        )
        assert resp.status_code == 429
        retry_after = int(resp.headers["Retry-After"])
        assert retry_after > 0

    def test_successful_login_counts_against_rate_limit(self, client: TestClient) -> None:
        self._setup_user(client)

        for _ in range(9):
            client.post(
                "/auth/verify-password",
                json={"email": "admin@test.com", "password": "WrongPass999"},
            )

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 200

        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 429

    def test_normal_login_within_rate_limit(self, client: TestClient) -> None:
        self._setup_user(client)
        resp = client.post(
            "/auth/verify-password",
            json={"email": "admin@test.com", "password": "SecurePass123"},
        )
        assert resp.status_code == 200
