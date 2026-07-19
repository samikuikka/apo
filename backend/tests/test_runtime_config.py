"""Tests for SPEC-124 self-hosted alpha topology runtime config + readiness."""

from pathlib import Path
from types import ModuleType
from typing import Any, cast

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import UserDB


def _reload_runtime_config() -> ModuleType:
    import importlib
    import sys

    _ = sys.modules.pop("apo.services.runtime_config", None)
    import apo.services.runtime_config as module

    return importlib.reload(module)


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
        from apo.services.runtime_config import (
            SUPPORTED_TOPOLOGY,
            get_runtime_config,
        )

        config = get_runtime_config()

        assert config.supported_topology == SUPPORTED_TOPOLOGY
        assert config.supported_topology == "single-node"
        assert config.task_execution_mode == "local_subprocess"
        assert isinstance(config.scheduler_enabled, bool)
        assert config.backend_url.startswith("http")
        assert config.frontend_url.startswith("http")
        assert config.database.engine in {"postgres", "sqlite", "unknown"}
        assert config.task_source_cache_dir


class TestReadinessChecks:
    def test_readiness_report_has_expected_check_names(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        cache_dir = tmp_path / "cache"
        _ = cache_dir.mkdir()
        monkeypatch.setenv("TASK_SOURCE_CACHE_DIR", str(cache_dir))
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        module = _reload_runtime_config()
        report = cast(ModuleType, module).run_readiness_checks()

        assert set(report.checks) == {"database", "task_source_cache", "auth_secret"}
        # Database + cache must pass; auth_secret is ok in dev mode.
        assert report.checks["database"].ok
        assert report.checks["task_source_cache"].ok
        assert report.checks["auth_secret"].ok

    def test_readiness_includes_task_runtime_when_scheduler_enabled(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        cache_dir = tmp_path / "cache"
        _ = cache_dir.mkdir()
        monkeypatch.setenv("TASK_SOURCE_CACHE_DIR", str(cache_dir))
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("SCHEDULER_ENABLED", "true")

        module = _reload_runtime_config()
        report = cast(ModuleType, module).run_readiness_checks()

        assert "task_runtime" in report.checks

    def test_unwritable_cache_dir_fails_readiness(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        cache_dir = tmp_path / "cache"
        _ = cache_dir.mkdir()
        # Remove all write bits so the probe cannot create a file.
        cache_dir.chmod(0o555)
        monkeypatch.setenv("TASK_SOURCE_CACHE_DIR", str(cache_dir))
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        try:
            module = _reload_runtime_config()
            report = cast(ModuleType, module).run_readiness_checks()

            assert not report.ok
            cache_check = report.checks["task_source_cache"]
            assert not cache_check.ok
            assert cache_check.detail is not None
            assert "not writable" in cache_check.detail
        finally:
            # Restore so cleanup can succeed.
            cache_dir.chmod(0o755)

    def test_insecure_auth_secret_fails_readiness_in_non_dev_mode(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        cache_dir = tmp_path / "cache"
        _ = cache_dir.mkdir()
        monkeypatch.setenv("TASK_SOURCE_CACHE_DIR", str(cache_dir))
        monkeypatch.setenv("AUTH_SECRET", "change-me-in-production")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        module = _reload_runtime_config()
        report = cast(ModuleType, module).run_readiness_checks()

        auth_check = report.checks["auth_secret"]
        assert not auth_check.ok
        assert auth_check.detail is not None
        assert "insecure" in auth_check.detail.lower()


class TestHealthReadyEndpoint:
    def test_health_ready_succeeds_for_healthy_stack(
        self,
        client: TestClient,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        cache_dir = tmp_path / "cache"
        _ = cache_dir.mkdir()
        monkeypatch.setenv("TASK_SOURCE_CACHE_DIR", str(cache_dir))
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        _ = _reload_runtime_config()

        response = client.get("/health/ready")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["ok"] is True
        assert "checks" in body

    def test_health_ready_reports_503_on_failure(
        self,
        client: TestClient,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        cache_dir = tmp_path / "cache"
        _ = cache_dir.mkdir()
        cache_dir.chmod(0o555)
        monkeypatch.setenv("TASK_SOURCE_CACHE_DIR", str(cache_dir))
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("SCHEDULER_ENABLED", "false")

        _ = _reload_runtime_config()
        try:
            response = client.get("/health/ready")
            assert response.status_code == 503, response.text
            body = response.json()
            assert body["ok"] is False
            assert body["checks"]["task_source_cache"]["ok"] is False
        finally:
            cache_dir.chmod(0o755)


class TestDatabaseDescriptorSanitization:
    """SPEC-124 hardening: never leak credentials via the runtime config API."""

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
        assert body["task_execution_mode"] == "local_subprocess"
        assert "scheduler_enabled" in body
        assert "backend_url" in body
        assert "frontend_url" in body
        # SPEC-124 hardening: database is a sanitized descriptor, NOT a raw DSN.
        assert "database_url" not in body
        db = body["database"]
        assert db["engine"] in {"postgres", "sqlite", "unknown"}
        # No credentials leak through the API surface.
        assert "credentials" not in db
        assert "password" not in body
        assert "task_source_cache_dir" in body
