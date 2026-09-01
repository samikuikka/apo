"""Anonymous demo access.

Two layers, both pinned here:

- **Middleware layer** (real ``AuthMiddleware`` in a release profile): a
  credential-less GET passes as the synthetic anonymous credential; a POST
  stays 401 byte-identical to today; the kill switch and the per-IP rate
  budget close the path; responses are never cacheable.
- **Route layer** (open-dev + injected ``auth_method="anonymous"``): the
  anonymous credential reads exactly the demo project at viewer level and
  nothing else.
"""

# pyright: reportPrivateUsage=false, reportUnusedCallResult=false

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import override

from _pytest.monkeypatch import MonkeyPatch
from fastapi import Request
from fastapi.responses import Response
from fastapi.testclient import TestClient
from sqlmodel import Session
from starlette.middleware.base import BaseHTTPMiddleware

from apo.db import engine
from apo.models.db import ProjectDB
from apo.services.project_memberships import (
    DEMO_PROJECT_ID,
    readable_project_ids_for_request,
)


def _enforce_real_auth(monkeypatch: MonkeyPatch) -> None:
    """Release profile + strong secret: the middleware must authenticate.

    No middleware reload is needed (or wanted): the profile, secret, and
    demo gates all read the environment live at request time. Reloads in
    other test files swap sys.modules for a NEW module the running app
    never uses — `_ORIGINAL_MIDDLEWARE` below keeps OUR handle on the one
    the app actually dispatches through.
    """
    monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
    monkeypatch.setenv("AUTH_SECRET", "a" * 32)
    monkeypatch.setenv("APO_DEMO_ENABLED", "true")


# The module object the running app's AuthMiddleware resolves names in.
# Captured at import, before any test reloads apo.auth.middleware.
import apo.auth.middleware as _ORIGINAL_MIDDLEWARE  # noqa: E402


class TestAnonymousMiddleware:
    def test_anonymous_get_passes_the_gate(
        self, client: TestClient, monkeypatch: MonkeyPatch
    ) -> None:
        _enforce_real_auth(monkeypatch)

        response = client.get("/v1/projects")
        assert response.status_code == 200

    def test_anonymous_get_carries_no_store(
        self, client: TestClient, monkeypatch: MonkeyPatch
    ) -> None:
        _enforce_real_auth(monkeypatch)

        response = client.get("/v1/projects")
        assert "no-store" in response.headers.get("Cache-Control", "")

    def test_anonymous_post_stays_401_like_today(
        self, client: TestClient, monkeypatch: MonkeyPatch, session: Session
    ) -> None:
        _enforce_real_auth(monkeypatch)

        response = client.post("/v1/runs", json={"project": "demo"})
        assert response.status_code == 401
        assert response.json() == {"detail": "Authentication required"}

    def test_anonymous_non_demo_read_fails_closed(
        self, client: TestClient, monkeypatch: MonkeyPatch, session: Session
    ) -> None:
        _enforce_real_auth(monkeypatch)
        session.add(ProjectDB(id="anon-other", name="Other"))
        session.commit()

        response = client.get("/v1/projects/anon-other")
        assert response.status_code == 401
        assert response.json() == {"detail": "Authentication required"}

    def test_kill_switch_closes_anonymous_access(
        self, client: TestClient, monkeypatch: MonkeyPatch
    ) -> None:
        _enforce_real_auth(monkeypatch)
        monkeypatch.setenv("APO_DEMO_ENABLED", "false")

        response = client.get("/v1/projects")
        assert response.status_code == 401

    def test_rate_budget_returns_429(
        self, client: TestClient, monkeypatch: MonkeyPatch
    ) -> None:
        # No middleware reload here: the secret and demo gates read the
        # environment live, and the running app shares the imported module
        # object — so patching the module attribute is seen by dispatch.
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        monkeypatch.setenv("AUTH_SECRET", "a" * 32)
        monkeypatch.setenv("APO_DEMO_ENABLED", "true")
        from apo.auth.rate_limit import LoginRateLimiter

        monkeypatch.setattr(
            _ORIGINAL_MIDDLEWARE,
            "_anonymous_demo_limiter",
            LoginRateLimiter(max_attempts=2, window_seconds=60),
        )

        assert client.get("/v1/projects").status_code == 200
        assert client.get("/v1/projects").status_code == 200
        limited = client.get("/v1/projects")
        assert limited.status_code == 429
        assert "Retry-After" in limited.headers


def _make_anonymous_client(session: Session) -> TestClient:
    """A TestClient whose requests carry the middleware-minted anonymous state."""
    from fastapi import FastAPI

    from apo.api import app
    from apo.db import get_session

    class InjectAnonymousMiddleware(BaseHTTPMiddleware):
        @override
        async def dispatch(
            self,
            request: Request,
            call_next: Callable[[Request], Awaitable[Response]],
        ) -> Response:
            request.state.auth_method = "anonymous"
            return await call_next(request)

    new_app = FastAPI()
    new_app.include_router(app.router)
    new_app.add_middleware(InjectAnonymousMiddleware)
    new_app.dependency_overrides[get_session] = lambda: session
    return TestClient(new_app)


class _FakeState:
    auth_method = "anonymous"


class _FakeRequest:
    state = _FakeState()


class TestAnonymousRouteAuthorization:
    def test_readable_set_is_exactly_demo(self, session: Session) -> None:
        assert readable_project_ids_for_request(_FakeRequest(), session) == [
            DEMO_PROJECT_ID
        ]

    def test_projects_list_is_anonymous_aware(self, session: Session) -> None:
        session.add(ProjectDB(id=DEMO_PROJECT_ID, name="Demo workspace"))
        session.add(ProjectDB(id="anon-real", name="Someone's project"))
        session.commit()

        client = _make_anonymous_client(session)
        response = client.get("/v1/projects")
        assert response.status_code == 200
        ids = [p["id"] for p in response.json()]
        assert ids == [DEMO_PROJECT_ID]

    def test_demo_detail_reports_viewer(
        self, session: Session
    ) -> None:
        session.add(ProjectDB(id=DEMO_PROJECT_ID, name="Demo workspace"))
        session.commit()

        client = _make_anonymous_client(session)
        response = client.get(f"/v1/projects/{DEMO_PROJECT_ID}")
        assert response.status_code == 200
        body = response.json()
        assert body["permissions"]["role"] == "viewer"
        assert body["permissions"]["can_run_tasks"] is False
