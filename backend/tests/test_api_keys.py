# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false
"""
Tests for API key CRUD endpoints (SPEC-065).

Test cases:
1. Create API key returns full key with prefix
2. Create API key hashes the key in storage
3. List API keys returns only prefix (never full key)
4. List API keys filters by user
5. Revoke API key deletes the key
6. Revoke nonexistent key returns 404
7. Revoke key created by another user returns 403
8. Create key without auth returns 401
9. Duplicate key names allowed
10. Multiple keys for same project all work
11. validate_api_key helper finds key by token
12. validate_api_key returns None for invalid token
13. Full create-list-revoke workflow
"""

import hashlib
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.auth.api_key_auth import (
    validate_basic_auth,
    validate_bearer_public_key,
)
from apo.models.db import ApiKeyDB, ProjectDB, UserDB
from apo.routes.api_keys import validate_api_key

from .conftest import TEST_PROJECT_ID, seed_project_for_user

_TEST_EMAIL = "test@example.com"
_TEST_PASSWORD = "TestPass123"
_TEST_NAME = "Test User"


def _setup_and_get_authed_client(
    client: TestClient, session: Session, make_authed_client: Any
) -> TestClient:
    """Create a user + a real project, then return an authed client.

    The user is the owner of ``TEST_PROJECT_ID`` so the strict
    project-role check on mint paths (issue #11) passes.
    """
    client.post(
        "/auth/setup",
        json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
    )
    user = session.exec(select(UserDB)).first()
    assert user is not None
    seed_project_for_user(session, user.id)
    return make_authed_client(user.id, session)


class TestCreateApiKey:
    def test_create_returns_key_pair(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Production", "project": "example-service"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Production"
        assert data["project"] == "example-service"
        assert data["public_key"].startswith("pk-apo-")
        assert data["secret_key"].startswith("sk-apo-")
        assert data["prefix"] == data["public_key"][:8]
        assert data["display_secret_key"].startswith("sk-apo-")
        assert "id" in data
        assert "created_at" in data
        # secret_key must not be stored in plaintext
        assert data["secret_key"] != data.get("display_secret_key")

    def test_create_hashes_secret_key_in_storage(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Test", "project": "example-service"},
        )
        secret_key = resp.json()["secret_key"]
        public_key = resp.json()["public_key"]

        db_key = session.exec(select(ApiKeyDB)).first()
        assert db_key is not None
        # hashed_secret_key must be SHA256(secret:salt), not plaintext
        assert db_key.hashed_secret_key is not None
        assert db_key.hashed_secret_key != secret_key
        # public_key stored
        assert db_key.public_key == public_key
        # legacy hashed_key must be None for new pair-based keys
        assert db_key.hashed_key is None

    def test_create_default_values(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.post("/v1/api-keys", json={})
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Default"
        assert data["project"] == "example-service"

    def test_create_without_auth_returns_401(self, client: TestClient) -> None:
        resp = client.post("/v1/api-keys", json={"name": "Test"})
        assert resp.status_code == 401

    def test_create_rejects_nonexistent_project_with_404(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        """Regression for issue #11: mint paths must require a real ProjectDB
        row. An admin must not be able to mint a key scoped to an arbitrary
        nonexistent project id."""
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Ghost", "project": "nonexistent-project"},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Project not found"
        # No key was created.
        assert session.exec(select(ApiKeyDB)).first() is None


class TestListApiKeys:
    def test_list_returns_public_key_and_masked_secret(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Prod", "project": "example-service"},
        )
        public_key = create_resp.json()["public_key"]

        resp = authed.get("/v1/api-keys")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 1

        listed = [k for k in data if k["name"] == "Prod"][0]
        assert listed["public_key"] == public_key
        assert listed["prefix"] == public_key[:8]
        assert listed["display_secret_key"].startswith("sk-apo-")
        # Never expose the full secret in list responses
        assert "secret_key" not in listed
        assert "key" not in listed

    def test_list_empty(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.get("/v1/api-keys")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_without_auth_returns_401(self, client: TestClient) -> None:
        resp = client.get("/v1/api-keys")
        assert resp.status_code == 401


class TestRevokeApiKey:
    def test_revoke_deletes_key(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "To Revoke", "project": "example-service"},
        )
        key_id = create_resp.json()["id"]

        resp = authed.delete(f"/v1/api-keys/{key_id}")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

        list_resp = authed.get("/v1/api-keys")
        ids = [k["id"] for k in list_resp.json()]
        assert key_id not in ids

    def test_revoke_nonexistent_returns_404(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        resp = authed.delete("/v1/api-keys/nonexistent")
        assert resp.status_code == 404

    def test_revoke_without_auth_returns_401(self, client: TestClient) -> None:
        resp = client.delete("/v1/api-keys/some-id")
        assert resp.status_code == 401


class TestValidateApiKey:
    def test_validate_finds_key(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Validate Me", "project": "example-service"},
        )
        public_key = create_resp.json()["public_key"]
        secret_key = create_resp.json()["secret_key"]

        # Basic auth validation (public:secret pair)
        result = validate_basic_auth(public_key, secret_key, session)
        assert result is not None
        assert result.name == "Validate Me"
        assert result.project == "example-service"

        # Public-key Bearer validation
        result_pk = validate_bearer_public_key(public_key, session)
        assert result_pk is not None
        assert result_pk.id == result.id

    def test_validate_basic_rejects_wrong_secret(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service"},
        )
        public_key = create_resp.json()["public_key"]

        result = validate_basic_auth(public_key, "sk-apo-wrong-secret", session)
        assert result is None

    def test_validate_returns_none_for_invalid(self, session: Session) -> None:
        result = validate_api_key("sk-nonexistentkey123456789", session)
        assert result is None


class TestEdgeCases:
    def test_duplicate_names_allowed(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        authed.post(
            "/v1/api-keys",
            json={"name": "Same Name", "project": "example-service"},
        )
        resp = authed.post(
            "/v1/api-keys",
            json={"name": "Same Name", "project": "example-service"},
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Same Name"

    def test_multiple_keys_same_project(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        public_keys = []
        for i in range(3):
            resp = authed.post(
                "/v1/api-keys",
                json={"name": f"Key {i}", "project": "example-service"},
            )
            assert resp.status_code == 200
            public_keys.append(resp.json()["public_key"])

        assert len(set(public_keys)) == 3


class TestFullWorkflow:
    def test_create_list_revoke(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Workflow Key", "project": "example-service"},
        )
        assert create_resp.status_code == 200
        key_id = create_resp.json()["id"]

        list_resp = authed.get("/v1/api-keys")
        assert any(k["id"] == key_id for k in list_resp.json())

        revoke_resp = authed.delete(f"/v1/api-keys/{key_id}")
        assert revoke_resp.status_code == 200

        list_resp2 = authed.get("/v1/api-keys")
        assert not any(k["id"] == key_id for k in list_resp2.json())


class TestBootstrapApiKey:
    """Tests for POST /v1/api-keys/bootstrap (CLI first-run login)."""

    @pytest.fixture(autouse=True)
    def _reset_bootstrap_rate_limiter(self) -> Iterator[None]:
        from apo.routes.api_keys import _bootstrap_rate_limiter

        _bootstrap_rate_limiter._attempts.clear()
        yield
        _bootstrap_rate_limiter._attempts.clear()

    def _setup_user_and_project(self, client: TestClient, session: Session) -> str:
        """Create the test user plus a real project they own, return user id.

        Issue #11 tightened the bootstrap mint path to require a real
        ProjectDB row, so the happy-path tests must seed one.
        """
        client.post(
            "/auth/setup",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
        )
        user = session.exec(select(UserDB)).first()
        assert user is not None
        seed_project_for_user(session, user.id)
        return user.id

    def test_bootstrap_with_valid_credentials_mints_key(
        self, client: TestClient, session: Session
    ) -> None:
        self._setup_user_and_project(client, session)

        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["key"].startswith("sk-")
        assert data["prefix"] == data["key"][:8]
        assert data["created_by"]
        assert data["scope"] == "full"
        assert data["project"] == TEST_PROJECT_ID

        from apo.routes.api_keys import validate_api_key

        validated = validate_api_key(data["key"], session)
        assert validated is not None
        assert validated.id == data["id"]

    def test_bootstrap_with_wrong_password_returns_401(
        self, client: TestClient
    ) -> None:
        client.post(
            "/auth/setup",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
        )

        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": "wrong-password",
                "project": TEST_PROJECT_ID,
            },
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"

    def test_bootstrap_with_unknown_email_returns_401(
        self, client: TestClient
    ) -> None:
        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": "nobody@example.com",
                "password": "whatever",
                "project": TEST_PROJECT_ID,
            },
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"

    def test_bootstrap_is_public_no_auth_header_required(
        self, client: TestClient, session: Session
    ) -> None:
        """Bootstrap must work without an Authorization header (chicken/egg)."""
        self._setup_user_and_project(client, session)
        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        assert resp.status_code == 200

    def test_bootstrap_hashes_key_in_storage(
        self, client: TestClient, session: Session
    ) -> None:
        self._setup_user_and_project(client, session)
        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        full_key = resp.json()["key"]

        db_key = session.exec(select(ApiKeyDB)).first()
        assert db_key is not None
        expected_hash = hashlib.sha256(full_key.encode()).hexdigest()
        assert db_key.hashed_key == expected_hash

    def test_bootstrap_assigns_user_id_as_creator(
        self, client: TestClient, session: Session
    ) -> None:
        user_id = self._setup_user_and_project(client, session)

        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        assert resp.json()["created_by"] == user_id

    def test_bootstrap_rejects_nonexistent_project_with_404(
        self, client: TestClient, session: Session
    ) -> None:
        """Regression for issue #11: a logged-in user must NOT be able to mint
        a key scoped to an arbitrary nonexistent project id. The legacy
        fallback would have returned 200 with a ghost-scoped key."""
        self._setup_user_and_project(client, session)
        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": "literally-anything",
            },
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Project not found"

        # No key was minted.
        assert session.exec(select(ApiKeyDB)).first() is None

    def test_bootstrap_rejects_nonexistent_default_project_with_404(
        self, client: TestClient
    ) -> None:
        """The schema default (``example-service``) is also a ghost unless a
        real project row exists for it. A fresh user with no project must
        get 404, not a ghost key — this is the exact quirk from issue #11."""
        client.post(
            "/auth/setup",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
        )
        # No project seeded — relies on the schema default.
        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Project not found"

    def test_bootstrap_rejects_project_user_is_not_a_member_of(
        self, client: TestClient, session: Session
    ) -> None:
        """Even when the project exists, the caller must be a member."""
        self._setup_user_and_project(client, session)
        # Create a second project the user has no membership in.
        other = ProjectDB(
            id="other-project",
            name="other",
            created_at=datetime.now(timezone.utc),
        )
        session.add(other)
        session.commit()

        resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": "other-project",
            },
        )
        assert resp.status_code == 403
