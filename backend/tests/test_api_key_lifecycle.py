# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportAttributeAccessIssue=false, reportArgumentType=false
"""
Tests for API key lifecycle: last_used_at, expires_at, scopes, rotation (SPEC-080).

Test cases:
1. Create key with ingest scope stores scope correctly
2. Create key with expiry stores expires_at
3. Create key with invalid scope returns 422
4. Create key with past expiry returns 422
5. List returns scope and expiry fields
6. Rotate generates new key and invalidates old
7. Rotate preserves name, project, scope
8. Rotate returns new full key shown once
9. _is_expired returns False for None expires_at
10. _is_expired returns True for past datetime
11. _is_expired returns False for future datetime
12. require_api_key_scope blocks wrong scope
13. require_api_key_scope allows correct scope
14. require_api_key_scope bypasses cookie auth
15. ApiKeyUsageTracker debounces writes
16. Rotation of nonexistent key returns 404
"""

import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from apo.auth.api_key_auth import validate_basic_auth
from apo.auth.api_key_tracker import ApiKeyUsageTracker
from apo.auth.deps import require_api_key_scope
from apo.auth.middleware import _is_expired
from apo.db import engine as db_engine
from apo.models.db import ApiKeyDB, UserDB

_TEST_EMAIL = "test@example.com"
_TEST_PASSWORD = "TestPass123"
_TEST_NAME = "Test User"


def _setup_and_get_authed_client(
    client: TestClient, session: Session, make_authed_client: Any
) -> TestClient:
    """Create a user via the public setup endpoint, then return an authed client."""
    client.post(
        "/auth/setup",
        json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
    )
    user = session.exec(select(UserDB)).first()
    assert user is not None
    return make_authed_client(user.id, session)


class TestCreateWithScopeAndExpiry:
    def test_create_with_ingest_scope(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Ingest Key", "project": "my-app", "scope": "ingest"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["scope"] == "ingest"

        db_key = session.exec(select(ApiKeyDB)).first()
        assert db_key is not None
        assert db_key.scope == "ingest"

    def test_create_with_expiry(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        future = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Expiring Key", "project": "my-app", "expires_at": future},
        )
        assert resp.status_code == 200
        assert resp.json()["expires_at"] is not None

    def test_create_with_full_scope_default(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Default Key", "project": "my-app"},
        )
        assert resp.status_code == 200
        assert resp.json()["scope"] == "full"

    def test_create_invalid_scope_returns_422(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Bad Scope", "project": "my-app", "scope": "admin"},
        )
        assert resp.status_code == 422
        assert "Invalid scope" in resp.json()["detail"]

    def test_create_past_expiry_returns_422(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Past Key", "project": "my-app", "expires_at": past},
        )
        assert resp.status_code == 422
        assert "future" in resp.json()["detail"].lower()


class TestListReturnsScopeAndExpiry:
    def test_list_includes_scope(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        authed.post(
            "/v1/api-keys",
            json={"name": "Scoped", "project": "app", "scope": "ingest"},
        )
        resp = authed.get("/v1/api-keys")
        assert resp.status_code == 200
        data = resp.json()
        assert any(k["scope"] == "ingest" for k in data)


class TestRotation:
    def test_rotate_returns_new_key_pair(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "To Rotate", "project": "app"},
        )
        key_id = create_resp.json()["id"]
        old_public_key = create_resp.json()["public_key"]
        old_secret_key = create_resp.json()["secret_key"]

        resp = authed.post(f"/v1/api-keys/{key_id}/rotate")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == key_id
        assert data["public_key"].startswith("pk-apo-")
        assert data["secret_key"].startswith("sk-apo-")
        assert data["public_key"] != old_public_key
        assert data["secret_key"] != old_secret_key

    def test_rotate_invalidates_old_key(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Rotate Me", "project": "app"},
        )
        key_id = create_resp.json()["id"]
        old_public_key = create_resp.json()["public_key"]
        old_secret_key = create_resp.json()["secret_key"]

        authed.post(f"/v1/api-keys/{key_id}/rotate")

        # Old secret should no longer validate via Basic auth
        old_result = validate_basic_auth(old_public_key, old_secret_key, session)
        assert old_result is None

    def test_rotate_preserves_metadata(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Prod", "project": "prod-app", "scope": "ingest"},
        )
        key_id = create_resp.json()["id"]
        created_by = create_resp.json()["created_by"]

        authed.post(f"/v1/api-keys/{key_id}/rotate")

        db_key = session.get(ApiKeyDB, key_id)
        assert db_key is not None
        assert db_key.name == "Prod"
        assert db_key.project == "prod-app"
        assert db_key.scope == "ingest"
        assert db_key.created_by == created_by

    def test_rotate_nonexistent_returns_404(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.post("/v1/api-keys/nonexistent/rotate")
        assert resp.status_code == 404


class TestIsExpired:
    def test_none_expires_at_returns_false(self) -> None:
        assert _is_expired(None) is False

    def test_past_datetime_returns_true(self) -> None:
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        assert _is_expired(past) is True

    def test_future_datetime_returns_false(self) -> None:
        future = datetime.now(timezone.utc) + timedelta(hours=1)
        assert _is_expired(future) is False


class TestRequireApiKeyScope:
    def _make_request(
        self, auth_method: str | None, scope: str | None = None
    ) -> Any:
        return SimpleNamespace(
            state=SimpleNamespace(
                auth_method=auth_method,
                api_key_scope=scope,
            )
        )

    def test_blocks_wrong_scope(self) -> None:
        checker = require_api_key_scope("full")
        request = self._make_request("api_key", "ingest")
        with pytest.raises(HTTPException) as exc_info:
            checker(request)
        assert exc_info.value.status_code == 403

    def test_allows_correct_scope(self) -> None:
        checker = require_api_key_scope("full", "ingest")
        request = self._make_request("api_key", "ingest")
        checker(request)

    def test_bypasses_cookie_auth(self) -> None:
        checker = require_api_key_scope("full")
        request = self._make_request(None)
        checker(request)


class TestApiKeyUsageTracker:
    def test_debounce_prevents_repeated_writes(self) -> None:
        tracker = ApiKeyUsageTracker(debounce_seconds=60)
        call_count = 0

        def counting_write(key_id: str, engine: Engine) -> None:
            nonlocal call_count
            call_count += 1

        tracker._write_last_used = counting_write  # type: ignore[method-assign]

        for _ in range(10):
            tracker.record_use("test-key-id", db_engine)

        assert call_count == 1

    def test_write_after_debounce_expires(self) -> None:
        tracker = ApiKeyUsageTracker(debounce_seconds=0)
        call_count = 0

        def counting_write(key_id: str, engine: Engine) -> None:
            nonlocal call_count
            call_count += 1

        tracker._write_last_used = counting_write  # type: ignore[method-assign]

        tracker.record_use("test-key-1", db_engine)
        time.sleep(0.01)
        tracker.record_use("test-key-1", db_engine)

        assert call_count == 2
