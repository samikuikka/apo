# pyright: reportAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false

"""Hardening from the security audit: readiness-detail exposure, explicit
Origin validation for cookie mutations, and apo.* INFO log emission."""

import logging
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session
from starlette.requests import Request

from apo.auth import hash_password
from apo.auth.middleware import _allowed_frontend_origins, _cookie_origin_allowed
from apo.models.db import UserDB
from apo.services.readiness import ReadinessCheckResult, ReadinessReport


def _report_with_detail() -> ReadinessReport:
    return ReadinessReport(
        ok=True,
        checks={
            "database": ReadinessCheckResult(
                name="database", ok=True, detail="sqlite:////app/data/apo.db"
            ),
            "auth_secret": ReadinessCheckResult(
                name="auth_secret", ok=True, detail="ok (42 chars)"
            ),
        }
    )


class TestReadinessDetailVisibility:
    def test_anonymous_caller_gets_verdicts_without_detail(
        self, client: TestClient
    ) -> None:
        with patch(
            "apo.routes.system_runtime.run_readiness_checks",
            return_value=_report_with_detail(),
        ):
            resp = client.get("/health/ready")
        assert resp.status_code == 200
        body = resp.json()
        assert body["checks"]["database"]["ok"] is True
        assert body["checks"]["database"]["detail"] is None
        assert body["checks"]["auth_secret"]["detail"] is None

    def test_credential_caller_sees_check_detail(
        self, client: TestClient, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        user = UserDB(
            email="ready-admin@test.com",
            name="Ready Admin",
            password_hash=hash_password("SecretPass123"),
            is_admin=True,
        )
        session.add(user)
        session.commit()
        authed = make_authed_client(user.id, session)
        with patch(
            "apo.routes.system_runtime.run_readiness_checks",
            return_value=_report_with_detail(),
        ):
            resp = authed.get("/health/ready")
        assert resp.status_code == 200
        assert resp.json()["checks"]["database"]["detail"] == "sqlite:////app/data/apo.db"


def _request(method: str, origin: str | None) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    return Request(
        {
            "type": "http",
            "method": method,
            "path": "/v1/runs",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
        }
    )


class TestCookieOriginValidation:
    def test_mutating_request_with_matching_origin_allowed(self) -> None:
        assert _cookie_origin_allowed(_request("POST", "http://localhost:3000")) is True

    def test_mutating_request_with_foreign_origin_rejected(self) -> None:
        assert _cookie_origin_allowed(_request("POST", "https://evil.example")) is False

    def test_missing_origin_allowed_for_non_browser_clients(self) -> None:
        assert _cookie_origin_allowed(_request("POST", None)) is True

    def test_safe_methods_always_allowed(self) -> None:
        assert _cookie_origin_allowed(_request("GET", "https://evil.example")) is True
        assert _cookie_origin_allowed(_request("HEAD", "https://evil.example")) is True

    def test_origin_trailing_slash_normalized(self) -> None:
        assert _cookie_origin_allowed(_request("POST", "http://localhost:3000/")) is True

    def test_allowed_origins_parse_comma_list(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(
            "FRONTEND_URL", "https://apo.example.com, https://other.example.org/"
        )
        assert _allowed_frontend_origins() == {
            "https://apo.example.com",
            "https://other.example.org",
        }


class TestApoLoggerEmitsInfo:
    def test_apo_logger_has_info_level_and_handler(self) -> None:
        apo_logger = logging.getLogger("apo")
        assert apo_logger.level == logging.INFO
        assert apo_logger.handlers, "apo logger must emit somewhere"

    def test_apo_info_lines_are_emitted(self, caplog: pytest.LogCaptureFixture) -> None:
        # The app attaches a real handler at create_app time (bound to the
        # process stdout of that moment, which pytest's capsys cannot
        # intercept) — caplog captures the same records via propagation.
        with caplog.at_level(logging.INFO, logger="apo"):
            logging.getLogger("apo.routes.auth").info(
                "Reset URL: http://probe/reset"
            )
        assert any(
            "Reset URL: http://probe/reset" in rec.message for rec in caplog.records
        )
