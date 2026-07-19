"""Tests for SPEC-132 Behavior 2: Authentication fails closed.

The open-dev auth bypass (unauthenticated access to protected routes)
was previously allowed whenever ``AUTH_SECRET`` was empty, regardless of
deployment profile. That meant a misconfigured release profile could
silently serve the entire API unauthenticated.

The v1 contract:

- Open-dev bypass is allowed ONLY when profile == ``development`` AND
  ``AUTH_SECRET`` is empty.
- ``local`` or ``server`` profiles with a missing, short, or
  known-placeholder secret must NOT serve protected routes
  unauthenticated — they fail closed (401), not open.
"""

from __future__ import annotations

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient


def _reload_middleware(monkeypatch: MonkeyPatch) -> None:
    """Reload the middleware module so module-level env reads are fresh.

    The middleware imports ``AUTH_SECRET`` from ``apo.auth`` at module
    load; the fail-closed decision reads the profile live. We reload to
    pick up env changes made via monkeypatch.
    """
    import importlib
    import sys

    _ = sys.modules.pop("apo.auth", None)
    _ = sys.modules.pop("apo.auth.middleware", None)
    import apo.auth as auth_module
    import apo.auth.middleware as mw_module

    importlib.reload(auth_module)
    importlib.reload(mw_module)


def _is_open_dev_allowed() -> bool:
    """Read the live decision from the (reloaded) middleware module."""
    from apo.auth import middleware as mw

    return mw._is_open_dev_bypass_allowed()


class TestOpenDevBypassIsDevelopmentOnly:
    """The open-dev bypass (no auth) is gated on profile == development."""

    def test_development_profile_with_no_secret_allows_open_dev(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        """Preserved behavior: ``pnpm dev`` with no AUTH_SECRET stays open."""
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "development")
        monkeypatch.setenv("AUTH_SECRET", "")
        _reload_middleware(monkeypatch)

        assert _is_open_dev_allowed() is True

    def test_local_profile_with_no_secret_does_not_allow_open_dev(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        """A release profile must never fall back to open-dev, even with
        an empty secret. It must fail closed instead."""
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        monkeypatch.setenv("AUTH_SECRET", "")
        _reload_middleware(monkeypatch)

        assert _is_open_dev_allowed() is False

    def test_server_profile_with_no_secret_does_not_allow_open_dev(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "server")
        monkeypatch.setenv("AUTH_SECRET", "")
        _reload_middleware(monkeypatch)

        assert _is_open_dev_allowed() is False

    def test_default_profile_is_development(self, monkeypatch: MonkeyPatch) -> None:
        """When APO_DEPLOYMENT_PROFILE is unset, behavior is development
        (so existing local-dev workflows keep working)."""
        monkeypatch.delenv("APO_DEPLOYMENT_PROFILE", raising=False)
        monkeypatch.setenv("AUTH_SECRET", "")
        _reload_middleware(monkeypatch)

        assert _is_open_dev_allowed() is True


class TestReleaseProfilesRejectWeakSecrets:
    """In local/server, a weak secret means fail-closed, not open-dev."""

    def test_local_with_short_secret_fails_closed(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        monkeypatch.setenv("AUTH_SECRET", "short")
        _reload_middleware(monkeypatch)

        assert _is_open_dev_allowed() is False

    def test_server_with_placeholder_secret_fails_closed(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "server")
        monkeypatch.setenv("AUTH_SECRET", "change-me-in-production")
        _reload_middleware(monkeypatch)

        assert _is_open_dev_allowed() is False

    def test_local_with_strong_secret_requires_auth(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        """A strong secret in a release profile means auth is enforced —
        not open-dev, but real authentication."""
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        monkeypatch.setenv("AUTH_SECRET", "a" * 32)
        _reload_middleware(monkeypatch)

        assert _is_open_dev_allowed() is False


class TestProtectedRouteFailsClosed:
    """End-to-end: a protected route returns 401 (not open access) when
    a release profile has a weak/missing secret."""

    def test_protected_route_401_in_local_without_secret(
        self,
        client: TestClient,
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        monkeypatch.setenv("AUTH_SECRET", "")
        _reload_middleware(monkeypatch)

        response = client.get("/v1/projects")

        assert response.status_code == 401

    def test_protected_route_401_in_server_with_placeholder(
        self,
        client: TestClient,
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "server")
        monkeypatch.setenv("AUTH_SECRET", "change-me")
        _reload_middleware(monkeypatch)

        response = client.get("/v1/projects")

        assert response.status_code == 401
