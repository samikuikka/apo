# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false
"""Tests for POST /v1/projects/bootstrap (first-project creation on a fresh instance).

Solves the chicken-and-egg of `apo login` (needs a project to scope a key to)
vs `POST /v1/projects` (needs an authenticated key). The endpoint accepts
email+password, creates the project + owner membership, and mints an API key
scoped to the new project — all in one call, with no dependency on the legacy
project tolerance in `require_project_role_or_legacy`.
"""

import hashlib
import re
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import ApiKeyDB, ProjectDB, ProjectMembershipDB, UserDB
from apo.routes.api_keys import validate_api_key

_TEST_EMAIL = "test@example.com"
_TEST_PASSWORD = "TestPass123"
_TEST_NAME = "Test User"


class TestProjectBootstrap:
    """Tests for POST /v1/projects/bootstrap (first-project CLI bootstrap)."""

    @pytest.fixture(autouse=True)
    def _reset_projects_bootstrap_rate_limiter(self) -> Iterator[None]:
        from apo.routes.projects import _projects_bootstrap_rate_limiter

        _projects_bootstrap_rate_limiter._attempts.clear()
        yield
        _projects_bootstrap_rate_limiter._attempts.clear()

    def _setup_user(self, client: TestClient) -> None:
        client.post(
            "/auth/setup",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": _TEST_NAME,
            },
        )

    def test_bootstrap_creates_project_and_mints_key(
        self, client: TestClient, session: Session
    ) -> None:
        self._setup_user(client)

        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "My First Project",
            },
        )
        assert resp.status_code == 201
        data = resp.json()

        # Key is a legacy single-key token, returned exactly once.
        assert data["key"].startswith("sk-")
        assert data["prefix"] == data["key"][:8]
        assert data["scope"] == "full"

        # The project id is a 12-hex string and is stamped on the key.
        project_id = data["project"]
        assert re.fullmatch(r"[0-9a-f]{12}", project_id)
        assert data["created_by"]

        # A real ProjectDB row exists with the requested name.
        project = session.get(ProjectDB, project_id)
        assert project is not None
        assert project.name == "My First Project"
        assert project.trace_content_policy == "redacted"
        assert project.created_by == data["created_by"]

        # The caller is the owner of the new project.
        membership = session.exec(
            select(ProjectMembershipDB).where(
                ProjectMembershipDB.project_id == project_id
            )
        ).first()
        assert membership is not None
        assert membership.role == "owner"
        assert membership.user_id == data["created_by"]

        # The key is hashed in storage and resolves via validate_api_key.
        validated = validate_api_key(data["key"], session)
        assert validated is not None
        assert validated.id == data["id"]
        assert validated.project == project_id

        db_key = session.exec(select(ApiKeyDB)).first()
        assert db_key is not None
        expected_hash = hashlib.sha256(data["key"].encode()).hexdigest()
        assert db_key.hashed_key == expected_hash

    def test_bootstrap_with_wrong_password_returns_401(
        self, client: TestClient
    ) -> None:
        self._setup_user(client)
        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": "wrong-password",
                "name": "p",
            },
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"

    def test_bootstrap_with_unknown_email_returns_401(
        self, client: TestClient
    ) -> None:
        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": "nobody@example.com",
                "password": "whatever",
                "name": "p",
            },
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"

    def test_bootstrap_is_public_no_auth_header_required(
        self, client: TestClient
    ) -> None:
        """Bootstrap must work without an Authorization header (chicken/egg)."""
        self._setup_user(client)
        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "no-auth-header",
            },
        )
        assert resp.status_code == 201

    def test_bootstrap_rejects_missing_name_with_422(
        self, client: TestClient
    ) -> None:
        self._setup_user(client)
        resp = client.post(
            "/v1/projects/bootstrap",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD},
        )
        assert resp.status_code == 422  # schema validation (name is required)

    def test_bootstrap_rejects_empty_name_with_400(
        self, client: TestClient
    ) -> None:
        self._setup_user(client)
        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "   ",
            },
        )
        assert resp.status_code == 400
        assert "name" in resp.json()["detail"].lower()

    def test_bootstrap_rejects_demo_name_case_insensitively(
        self, client: TestClient
    ) -> None:
        """A user-named 'demo' would collide conceptually with the shared demo
        project id; reject it explicitly (the id-based guard can't catch this)."""
        self._setup_user(client)
        for name in ("demo", "Demo", "DEMO"):
            resp = client.post(
                "/v1/projects/bootstrap",
                json={
                    "email": _TEST_EMAIL,
                    "password": _TEST_PASSWORD,
                    "name": name,
                },
            )
            assert resp.status_code == 400, f"name={name!r} should be rejected"
            assert "demo" in resp.json()["detail"].lower()

    def test_bootstrap_rejects_invalid_trace_content_policy_with_422(
        self, client: TestClient
    ) -> None:
        self._setup_user(client)
        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "p",
                "trace_content_policy": "garbage",  # type: ignore[list-item]
            },
        )
        assert resp.status_code == 422  # schema Literal validation

    def test_bootstrap_respects_trace_content_policy(
        self, client: TestClient, session: Session
    ) -> None:
        self._setup_user(client)
        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "full-trace",
                "trace_content_policy": "full",
            },
        )
        assert resp.status_code == 201
        project = session.get(ProjectDB, resp.json()["project"])
        assert project is not None
        assert project.trace_content_policy == "full"

    def test_bootstrap_supports_ingest_scope(
        self, client: TestClient, session: Session
    ) -> None:
        self._setup_user(client)
        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "ingest-only",
                "scope": "ingest",
            },
        )
        assert resp.status_code == 201
        assert resp.json()["scope"] == "ingest"

        validated = validate_api_key(resp.json()["key"], session)
        assert validated is not None
        assert validated.scope == "ingest"

    def test_bootstrap_assigns_user_id_as_creator(
        self, client: TestClient, session: Session
    ) -> None:
        self._setup_user(client)
        user = session.exec(select(UserDB)).first()
        assert user is not None

        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "creator-test",
            },
        )
        assert resp.json()["created_by"] == user.id

    def test_bootstrap_rate_limits_after_5_attempts(
        self, client: TestClient
    ) -> None:
        self._setup_user(client)
        body = {
            "email": _TEST_EMAIL,
            "password": "wrong",  # always fails auth, but rate limit fires first on 6th
            "name": "p",
        }
        for _ in range(5):
            assert client.post("/v1/projects/bootstrap", json=body).status_code == 401
        sixth = client.post("/v1/projects/bootstrap", json=body)
        assert sixth.status_code == 429
        assert "Retry-After" in sixth.headers

    def test_bootstrap_does_not_leak_legacy_project_quirk(
        self, client: TestClient, session: Session
    ) -> None:
        """Regression guard: the new endpoint must create a REAL ProjectDB row
        before minting the key, so `require_project_role_or_legacy` would take
        its normal branch. Concretely, the minted key's project must resolve
        to a real project — not a synthetic legacy-{id} membership."""
        self._setup_user(client)
        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "real-project",
            },
        )
        assert resp.status_code == 201
        project_id = resp.json()["project"]

        # The project row exists (not a legacy ghost).
        assert session.get(ProjectDB, project_id) is not None

        # No legacy-* membership id was created.
        legacy = session.exec(
            select(ProjectMembershipDB).where(
                ProjectMembershipDB.id.startswith("legacy-")
            )
        ).first()
        assert legacy is None
