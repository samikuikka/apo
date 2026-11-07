# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Malformed input must get clean 4xx responses, never 500s.

Fuzzing the running API showed three crash classes reachable by any
caller (the JSON ones on public auth routes, unauthenticated):

- deep nesting, lone-surrogate keys, and Infinity values crash FastAPI's
  default 422 handler, which echoes the raw input back into the error
  details (RecursionError, UnicodeEncodeError, ValueError on re-encode);
- a lone surrogate in a stored field value reaches SQLite binding and
  raises UnicodeEncodeError (500 on write);
- a 26-digit integer id overflows SQLite's 64-bit row id in
  ``session.get`` (500 on models and webhooks lookups).
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

_TEST_EMAIL = "malformed@example.com"
_TEST_PASSWORD = "TestPass123"

_DEEP = b'{"a":' * 3000 + b"1" + b"}" * 3000
_SURROGATE_KEY = b'{"\\ud800": 1}'
_INFINITY_EMAIL = b'{"email": Infinity}'
_HUGE_ID = "9" * 26


@pytest.fixture(autouse=True)
def _force_auth_secret(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(auth_module, "AUTH_SECRET", "test-auth-secret")
    monkeypatch.setattr(auth_middleware, "AUTH_SECRET", "test-auth-secret")


@pytest.fixture(autouse=True)
def _patch_middleware_engine(monkeypatch: MonkeyPatch, session: Session) -> None:
    """Point AuthMiddleware at the in-memory test DB so it finds the key."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())


def _authed(client: TestClient, session: Session, make_authed_client: Any) -> TestClient:
    client.post(
        "/auth/setup",
        json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": "Malformed"},
    )
    user = session.exec(select(UserDB)).first()
    assert user is not None
    seed_project_for_user(session, user.id)
    return make_authed_client(user.id, session)


class TestValidationErrorResponseHardening:
    def test_deeply_nested_json_gets_422_not_500(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/verify-password",
            content=_DEEP,
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422
        assert isinstance(resp.json()["detail"], list)

    def test_surrogate_key_gets_422_not_500(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/verify-password",
            content=_SURROGATE_KEY,
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422
        assert isinstance(resp.json()["detail"], list)

    def test_infinity_value_gets_422_not_500(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/verify-password",
            content=_INFINITY_EMAIL,
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422
        assert isinstance(resp.json()["detail"], list)


class TestUnencodableTextInput:
    def test_surrogate_value_in_stored_field_gets_422_not_500(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        """Runs on the real app object: make_authed_client rebuilds a bare
        FastAPI shell without the app-level exception handlers, but the
        handlers are part of the production surface under test."""
        client.post(
            "/auth/setup",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": "Malformed"},
        )
        user = session.exec(select(UserDB)).first()
        assert user is not None
        seed_project_for_user(session, user.id)
        minted = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": "example-service",
                "scope": "full",
                "name": "malformed-probe",
            },
        )
        assert minted.status_code == 200, minted.text
        bearer = {"Authorization": f"Bearer {minted.json()['key']}"}
        resp = client.post(
            "/v1/projects/example-service/task-views",
            content=b'{"label":"\\ud800bad"}',
            headers={**bearer, "Content-Type": "application/json"},
        )
        assert resp.status_code == 422


class TestSqliteRowIdBounds:
    def test_huge_model_id_gets_422_not_500(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        # Authenticated: with auth enforced (as in CI) an anonymous hit
        # would 401 at the middleware before the id ever gets validated.
        authed = _authed(client, session, make_authed_client)
        resp = authed.get(f"/api/v1/models/{_HUGE_ID}")
        assert resp.status_code == 422

    def test_huge_webhook_id_gets_422_not_500(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _authed(client, session, make_authed_client)
        resp = authed.get(f"/v1/webhooks/{_HUGE_ID}")
        assert resp.status_code == 422
