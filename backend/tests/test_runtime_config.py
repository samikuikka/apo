"""Tests for self-hosted alpha topology runtime config + readiness."""

# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false

from typing import Any

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import UserDB
from apo.services.runtime_config import run_readiness_checks


def _setup_admin_user(client: TestClient, session: Session) -> str:
    """Create one admin user via the public setup endpoint and return its id."""
    resp = client.post(
        "/auth/setup",
        json={"email": "admin@test.com", "password": "AdminPass123", "name": "Admin"},
    )
    assert resp.status_code == 200, resp.text
    admin_user = session.exec(select(UserDB)).first()
    assert admin_user is not None
    admin_user.is_admin = True
    session.add(admin_user)
    session.commit()
    session.refresh(admin_user)
    return admin_user.id


class TestRuntimeConfig:
    def test_get_runtime_config_returns_supported_topology(self) -> None:
        from apo.services.runtime_config import get_runtime_config

        config = get_runtime_config()

        assert config.supported_topology == "single-node"
        assert config.task_execution_mode == "executor_pools"
        assert isinstance(config.scheduler_enabled, bool)
        assert config.backend_url.startswith("http")
        assert config.frontend_url.startswith("http")
        assert config.database.engine in {"postgres", "sqlite", "unknown"}
        assert config.task_source_cache_dir


class TestReadinessChecks:
    def test_readiness_report_has_expected_check_names(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        report = run_readiness_checks()

        assert set(report.checks) == {
            "database",
            "auth_secret",
            "artifact_store",
        }
        # Database must pass; auth_secret is ok in dev mode.
        assert report.checks["database"].ok
        assert report.checks["auth_secret"].ok
        # the local artifact store is ready by default (zero-config).
        assert report.checks["artifact_store"].ok

    def test_readiness_does_not_depend_on_task_runtime_when_scheduler_enabled(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("SCHEDULER_ENABLED", "true")

        report = run_readiness_checks()

        assert "task_runtime" not in report.checks

    def test_insecure_auth_secret_fails_readiness_in_non_dev_mode(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AUTH_SECRET", "change-me-in-production")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        report = run_readiness_checks()

        auth_check = report.checks["auth_secret"]
        assert not auth_check.ok
        assert auth_check.detail is not None
        assert "insecure" in auth_check.detail.lower()


class TestHealthReadyEndpoint:
    def test_health_ready_succeeds_for_healthy_stack(
        self,
        client: TestClient,
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        response = client.get("/health/ready")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["ok"] is True
        assert "checks" in body

    def test_health_ready_reports_503_on_failure(
        self,
        client: TestClient,
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("AUTH_SECRET", "change-me-in-production")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        response = client.get("/health/ready")
        assert response.status_code == 503, response.text
        body = response.json()
        assert body["ok"] is False
        assert body["checks"]["auth_secret"]["ok"] is False


class TestDatabaseDescriptorSanitization:
    """Hardening: never leak credentials via the runtime config API."""

    def test_postgres_dsn_strips_credentials(self) -> None:
        from apo.services.runtime_config import _describe_database

        descriptor = _describe_database(
            "postgresql://postgres:supersecret@db.example.com:5432/prod"
        )
        assert descriptor.engine == "postgres"
        assert descriptor.host == "db.example.com"
        assert descriptor.name == "prod"
        assert descriptor.credentials_configured is True
        assert descriptor.shared_use_recommended is True
        # The serialized form must not contain the password.
        serialized = descriptor.model_dump_json()
        assert "supersecret" not in serialized

    def test_sqlite_dsn_has_no_credentials(self) -> None:
        from apo.services.runtime_config import _describe_database

        descriptor = _describe_database("sqlite:///var/lib/app/data.db")
        assert descriptor.engine == "sqlite"
        assert descriptor.host is None
        assert descriptor.name == "/var/lib/app/data.db"
        assert descriptor.credentials_configured is False
        assert descriptor.shared_use_recommended is False

    def test_unknown_engine_returns_safe_default(self) -> None:
        from apo.services.runtime_config import _describe_database

        descriptor = _describe_database("mysql://user:pw@host/db")
        assert descriptor.engine == "unknown"
        assert descriptor.credentials_configured is False
        assert descriptor.shared_use_recommended is False

    def test_empty_dsn_is_safe(self) -> None:
        from apo.services.runtime_config import _describe_database

        descriptor = _describe_database("")
        assert descriptor.engine == "unknown"


class TestRuntimeConfigEndpoint:
    def test_runtime_config_requires_admin(self, client: TestClient) -> None:
        response = client.get("/v1/system/runtime-config")
        # No auth middleware in tests → unauthenticated.
        assert response.status_code == 401

    def test_runtime_config_returns_topology_for_admin(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        admin_id = _setup_admin_user(client, session)
        authed = make_authed_client(admin_id, session, is_admin=True)
        response = authed.get("/v1/system/runtime-config")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["supported_topology"] == "single-node"
        assert body["task_execution_mode"] == "executor_pools"
        assert "scheduler_enabled" in body
        assert "backend_url" in body
        assert "frontend_url" in body
        # database is a sanitized descriptor, NOT a raw DSN.
        assert "database_url" not in body
        db = body["database"]
        assert db["engine"] in {"postgres", "sqlite", "unknown"}
        # No credentials leak through the API surface.
        assert "credentials" not in db
        assert "password" not in body
        assert "task_source_cache_dir" in body
