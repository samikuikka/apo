"""Regression tests for the middleware PUBLIC_PATHS allow-list.

The route tests in this suite run under an autouse fixture that forces
``AUTH_SECRET=""`` (``open_dev_auth_bypass`` in conftest.py), which disables
the auth middleware entirely. That means a route can be reachable in tests
but 401-blocked in production whenever it is missing from
``PUBLIC_PATHS`` — exactly the gap that silently broke
``POST /v1/projects/bootstrap`` (the ``apo project create`` CLI flow) on
every real deployment.

These tests pin the production behavior: with a real secret set and the
open-dev bypass off, every password/authenticated-in-handler bootstrap
route must still be reachable without a session.
"""

from __future__ import annotations

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient

from .test_auth_fail_closed import _reload_middleware


def _enforce_real_auth(monkeypatch: MonkeyPatch) -> None:
    """Configure the middleware to enforce auth like a real deployment.

    A release profile + a strong secret means the open-dev bypass is off
    and every non-public path returns 401 without credentials. This mirrors
    the production Docker stack (``AUTH_SECRET`` set, profile unset).
    """
    monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
    monkeypatch.setenv("AUTH_SECRET", "a" * 32)
    _reload_middleware(monkeypatch)


class TestBootstrapRoutesArePublicWithRealSecret:
    """Both first-run bootstrap routes authenticate inside the handler
    (email + password), so they must be in PUBLIC_PATHS — otherwise the
    middleware 401-blocks them before the handler runs."""

    def test_api_keys_bootstrap_reachable_with_real_secret(
        self, client: TestClient, monkeypatch: MonkeyPatch
    ) -> None:
        _enforce_real_auth(monkeypatch)

        # Wrong credentials → handler-level 401/400, NOT the middleware's
        # "Authentication required" 401. A 401 here is fine (handler ran);
        # what would fail is if the middleware blocked it. We assert the
        # response is not the generic middleware 401 by checking that the
        # handler ran far enough to return its own detail shape.
        response = client.post(
            "/v1/api-keys/bootstrap",
            json={"email": "nobody@example.com", "password": "x", "name": "k"},
        )
        # Handler returned its own error, not the middleware's generic 401.
        assert response.status_code in (401, 400, 422)
        # The middleware's blanket rejection says "Authentication required";
        # the handler says something credential-specific. If we see the
        # middleware's exact wording, PUBLIC_PATHS is missing the route.
        assert response.json().get("detail") != "Authentication required"

    def test_projects_bootstrap_reachable_with_real_secret(
        self, client: TestClient, monkeypatch: MonkeyPatch
    ) -> None:
        """Regression for the bug where ``/v1/projects/bootstrap`` was
        missing from PUBLIC_PATHS, making ``apo project create`` fail with
        a generic 401 on every real deployment."""
        _enforce_real_auth(monkeypatch)

        response = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": "nobody@example.com",
                "password": "x",
                "name": "p",
            },
        )
        assert response.status_code in (401, 400, 422)
        assert response.json().get("detail") != "Authentication required"
