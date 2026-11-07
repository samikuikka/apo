# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedParameter=false, reportUnusedFunction=false

"""Ingest-scoped API keys are write-only telemetry credentials.

The schema documents scope ``ingest`` as the least privilege required for
telemetry (``models/schemas.py``: "scope defaults to ingest (the least
privilege required ..."), and route-level ``require_api_key_scope("full")``
guards already refuse ingest keys on key management, webhooks, automations,
admin, and task-definition surfaces. But product routes with no scope
dependency (task-run reads, task views, comments, ...) authorized ingest
keys through the ordinary Project policy, handing a telemetry-only
credential full member-level read and write inside its Project.

These tests pin the confinement: an ingest key reaches exactly the
protected telemetry write routes and nothing else.
"""

import base64
from typing import Any

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo import auth as auth_module
from apo.auth import middleware as auth_middleware
from apo.models.db import UserDB

from .conftest import seed_project_for_user

_TEST_EMAIL = "test@example.com"
_TEST_PASSWORD = "TestPass123"
_TEST_NAME = "Test User"


@pytest.fixture(autouse=True)
def _force_auth_secret(monkeypatch: MonkeyPatch) -> None:
    """Enable AuthMiddleware by setting AUTH_SECRET."""
    monkeypatch.setattr(auth_module, "AUTH_SECRET", "test-auth-secret")
    monkeypatch.setattr(auth_middleware, "AUTH_SECRET", "test-auth-secret")


@pytest.fixture(autouse=True)
def _patch_middleware_engine(monkeypatch: MonkeyPatch, session: Session) -> None:
    """Point middleware at the in-memory test DB so it can find keys created in tests."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())


def _mint_key(
    client: TestClient,
    session: Session,
    make_authed_client: Any,
    scope: str,
) -> tuple[str, str]:
    """Create a user + project, then mint an API key with the given scope."""
    client.post(
        "/auth/setup",
        json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
    )
    user = session.exec(select(UserDB)).first()
    assert user is not None
    seed_project_for_user(session, user.id)
    authed = make_authed_client(user.id, session)
    resp = authed.post(
        "/v1/api-keys",
        json={"name": f"probe-{scope}", "project": "example-service", "scope": scope},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return body["public_key"], body["secret_key"]


def _basic(public_key: str, secret_key: str) -> dict[str, str]:
    credentials = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
    return {"Authorization": f"Basic {credentials}"}


class TestIngestKeyConfinedToTelemetry:
    def test_ingest_key_cannot_list_task_runs(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        public_key, secret_key = _mint_key(client, session, make_authed_client, "ingest")
        resp = client.get(
            "/v1/agent-task-runs",
            params={"project": "example-service"},
            headers=_basic(public_key, secret_key),
        )
        assert resp.status_code == 403, resp.text

    def test_ingest_key_cannot_write_product_routes(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        public_key, secret_key = _mint_key(client, session, make_authed_client, "ingest")
        resp = client.post(
            "/v1/projects/example-service/task-views",
            json={"label": "probe-view"},
            headers=_basic(public_key, secret_key),
        )
        assert resp.status_code == 403, resp.text

    def test_ingest_key_cannot_read_project_listing(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        public_key, secret_key = _mint_key(client, session, make_authed_client, "ingest")
        resp = client.get(
            "/v1/projects",
            headers=_basic(public_key, secret_key),
        )
        assert resp.status_code == 403, resp.text

    def test_ingest_key_can_post_otlp_traces(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """The intended use: telemetry writes stay open to ingest keys."""
        public_key, secret_key = _mint_key(client, session, make_authed_client, "ingest")
        resp = client.post(
            "/api/public/otel/v1/traces",
            headers={
                **_basic(public_key, secret_key),
                "Content-Type": "application/json",
            },
            json={"resourceSpans": []},
        )
        assert resp.status_code == 200, resp.text

    def test_full_key_keeps_product_access(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """The confinement must not clip full keys."""
        public_key, secret_key = _mint_key(client, session, make_authed_client, "full")
        resp = client.get(
            "/v1/agent-task-runs",
            params={"project": "example-service"},
            headers=_basic(public_key, secret_key),
        )
        assert resp.status_code == 200, resp.text
