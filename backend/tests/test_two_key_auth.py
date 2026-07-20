# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedParameter=false, reportExplicitAny=false, reportUnusedFunction=false

"""Tests for the two-key API model (SPEC-092).

Covers key pair generation, Basic auth validation, public-key Bearer validation,
legacy Bearer backward compat, and middleware integration for all three wire formats.
"""

import base64
from typing import Any

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo import auth as auth_module
from apo.auth import middleware as auth_middleware
from apo.auth.api_key_auth import (
    generate_key_pair,
    is_public_key,
    validate_basic_auth,
    validate_bearer_public_key,
    validate_legacy_bearer,
)
from apo.models.db import ApiKeyDB, UserDB

from .conftest import TEST_PROJECT_ID, seed_project_for_user

_TEST_EMAIL = "test@example.com"
_TEST_PASSWORD = "TestPass123"
_TEST_NAME = "Test User"


def _setup_and_get_authed_client(
    client: TestClient, session: Session, make_authed_client: Any
) -> TestClient:
    client.post(
        "/auth/setup",
        json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
    )
    user = session.exec(select(UserDB)).first()
    assert user is not None
    # Issue #11: mint paths require a real project + membership.
    seed_project_for_user(session, user.id)
    return make_authed_client(user.id, session)


@pytest.fixture(autouse=True)
def _force_auth_secret(monkeypatch: MonkeyPatch) -> None:
    """Enable AuthMiddleware by setting AUTH_SECRET."""
    monkeypatch.setattr(auth_module, "AUTH_SECRET", "test-auth-secret")
    monkeypatch.setattr(auth_middleware, "AUTH_SECRET", "test-auth-secret")


@pytest.fixture(autouse=True)
def _patch_middleware_engine(monkeypatch: MonkeyPatch, session: Session) -> None:
    """Point middleware at the in-memory test DB so it can find keys created in tests."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())


# ---------------------------------------------------------------------------
# Unit tests: key generation and format
# ---------------------------------------------------------------------------


class TestKeyGeneration:
    def test_generate_key_pair_produces_correct_prefixes(self) -> None:
        public_key, secret_key, hashed_secret_key, display_secret_key = (
            generate_key_pair()
        )
        assert public_key.startswith("pk-apo-")
        assert secret_key.startswith("sk-apo-")
        assert hashed_secret_key != secret_key
        assert display_secret_key.startswith("sk-apo-")
        assert "..." in display_secret_key
        assert len(display_secret_key) < len(secret_key)

    def test_generate_key_pair_produces_unique_keys(self) -> None:
        public_keys = {generate_key_pair()[0] for _ in range(10)}
        secret_keys = {generate_key_pair()[1] for _ in range(10)}
        assert len(public_keys) == 10
        assert len(secret_keys) == 10

    def test_is_public_key_detects_prefix(self) -> None:
        assert is_public_key("pk-apo-some-uuid") is True
        assert is_public_key("sk-apo-some-uuid") is False
        assert is_public_key("sk-legacylegacy") is False


# ---------------------------------------------------------------------------
# Unit tests: validation functions (using test DB session)
# ---------------------------------------------------------------------------


class TestValidationFunctions:
    def test_validate_basic_auth_finds_key(
        self, session: Session
    ) -> None:
        public_key, secret_key, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
                scope="full",
            )
        )
        session.commit()

        result = validate_basic_auth(public_key, secret_key, session)
        assert result is not None
        assert result.public_key == public_key
        assert result.project == "test"

    def test_validate_basic_auth_rejects_wrong_secret(
        self, session: Session
    ) -> None:
        public_key, _, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        result = validate_basic_auth(public_key, "sk-apo-wrong-secret", session)
        assert result is None

    def test_validate_bearer_public_key_finds_key(
        self, session: Session
    ) -> None:
        public_key, _, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        result = validate_bearer_public_key(public_key, session)
        assert result is not None
        assert result.public_key == public_key

    def test_validate_bearer_public_key_returns_none_for_nonexistent(
        self, session: Session
    ) -> None:
        result = validate_bearer_public_key("pk-apo-nonexistent", session)
        assert result is None

    def test_validate_legacy_bearer_finds_key(
        self, session: Session
    ) -> None:
        import hashlib

        token = "sk-abcdef1234567890"
        hashed = hashlib.sha256(token.encode()).hexdigest()
        session.add(
            ApiKeyDB(
                name="Legacy",
                prefix=token[:8],
                hashed_key=hashed,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        result = validate_legacy_bearer(token, session)
        assert result is not None
        assert result.name == "Legacy"

    def test_validate_legacy_bearer_returns_none_for_invalid(
        self, session: Session
    ) -> None:
        result = validate_legacy_bearer("sk-nonexistent", session)
        assert result is None


# ---------------------------------------------------------------------------
# Integration tests: middleware (Basic auth, public-key Bearer, legacy Bearer)
# ---------------------------------------------------------------------------


class TestMiddlewareBasicAuth:
    def test_basic_auth_grants_access(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service"},
        )
        public_key = create_resp.json()["public_key"]
        secret_key = create_resp.json()["secret_key"]

        credentials = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {credentials}"},
        )
        assert resp.status_code == 200

    def test_basic_auth_wrong_secret_returns_401(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service"},
        )
        public_key = create_resp.json()["public_key"]

        credentials = base64.b64encode(
            f"{public_key}:sk-apo-wrong".encode()
        ).decode()
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {credentials}"},
        )
        assert resp.status_code == 401

    def test_malformed_basic_auth_returns_401(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": "Basic not-valid-base64!!!"},
        )
        assert resp.status_code == 401


class TestMiddlewarePublicKeyBearer:
    def test_public_key_bearer_grants_ingest_scope(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service", "scope": "full"},
        )
        public_key = create_resp.json()["public_key"]

        # Ingestion endpoint allows ingest scope
        resp = client.post(
            "/api/v1/ingestion",
            headers={"Authorization": f"Bearer {public_key}"},
            json={"batch": []},
        )
        assert resp.status_code == 200

    def test_public_key_bearer_blocked_from_key_management(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service", "scope": "full"},
        )
        public_key = create_resp.json()["public_key"]

        # Key management requires "full" scope; public-key Bearer forces "ingest"
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Bearer {public_key}"},
        )
        assert resp.status_code == 403

    def test_public_key_bearer_nonexistent_returns_401(
        self, client: TestClient
    ) -> None:
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": "Bearer pk-apo-nonexistent-uuid"},
        )
        assert resp.status_code == 401


class TestMiddlewareLegacyBearer:
    def test_legacy_bearer_still_works(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """Bootstrap creates legacy keys; they must still authenticate via Bearer."""
        client.post(
            "/auth/setup",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
        )
        user = session.exec(select(UserDB)).first()
        assert user is not None
        seed_project_for_user(session, user.id)
        bootstrap_resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        legacy_key = bootstrap_resp.json()["key"]

        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Bearer {legacy_key}"},
        )
        assert resp.status_code == 200


class TestRotationUpgradesLegacyKey:
    def test_rotation_upgrades_legacy_to_pair(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """Rotating a legacy key should upgrade it to the two-key model."""
        client.post(
            "/auth/setup",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
        )
        user = session.exec(select(UserDB)).first()
        assert user is not None
        seed_project_for_user(session, user.id)
        bootstrap_resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        key_id = bootstrap_resp.json()["id"]
        old_legacy_key = bootstrap_resp.json()["key"]

        # Verify it's a legacy key (hashed_key set, no public_key)
        db_key = session.get(ApiKeyDB, key_id)
        assert db_key is not None
        assert db_key.hashed_key is not None
        assert db_key.public_key is None

        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        rotate_resp = authed.post(f"/v1/api-keys/{key_id}/rotate")
        assert rotate_resp.status_code == 200
        data = rotate_resp.json()
        assert data["public_key"].startswith("pk-apo-")
        assert data["secret_key"].startswith("sk-apo-")

        # Verify DB record is upgraded
        session.refresh(db_key)
        assert db_key.public_key == data["public_key"]
        assert db_key.hashed_secret_key is not None
        assert db_key.hashed_key is None  # Legacy key cleared

        # Old legacy key should no longer validate
        old_result = validate_legacy_bearer(old_legacy_key, session)
        assert old_result is None
