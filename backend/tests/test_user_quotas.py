# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnusedFunction=false, reportUnusedCallResult=false

"""Per-user creation count caps (max_api_keys, max_projects).

NULL = installation default (5, env-tunable), 0 = creation frozen,
N = cap, and an explicit column always beats the env default. Enforced
on POST /v1/api-keys, both bootstrap mints, POST /v1/projects, and
POST /v1/projects/bootstrap before any write, so a key-cap denial
never strands an orphan project row.

Denials are 403, never 429: released CLIs answer every 429 with
"Too many attempts. Try again in a few minutes." (project-create.ts),
and a creation cap lifts only when the user revokes a row or an admin
raises the cap, so a retry-later message would promise an outcome
waiting cannot deliver. The detail is a plain string (rendered
verbatim by the CLI) and the numbers ride X-RateLimit-Limit/-Used.
"""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import ApiKeyDB, ProjectDB, UserDB

from .conftest import TEST_PROJECT_ID, seed_project_for_user

_TEST_EMAIL = "quota@test.dev"
_TEST_PASSWORD = "TestPass123"


@pytest.fixture(autouse=True)
def _reset_bootstrap_rate_limiters() -> Iterator[None]:
    from apo.routes.api_keys import _bootstrap_rate_limiter
    from apo.routes.projects import _projects_bootstrap_rate_limiter

    _bootstrap_rate_limiter._attempts.clear()
    _projects_bootstrap_rate_limiter._attempts.clear()
    yield
    _bootstrap_rate_limiter._attempts.clear()
    _projects_bootstrap_rate_limiter._attempts.clear()


def _setup_user(client: TestClient, session: Session) -> UserDB:
    """Create the first user (installation admin) and load its row."""
    resp = client.post(
        "/auth/setup",
        json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": "Quota User"},
    )
    assert resp.status_code == 200
    user = session.exec(select(UserDB).where(UserDB.email == _TEST_EMAIL)).first()
    assert user is not None
    return user


def _set_caps(session: Session, user: UserDB, **columns: int | None) -> None:
    """Write the quota columns directly; creation routes read them live."""
    session.refresh(user)
    for column, value in columns.items():
        setattr(user, column, value)
    session.add(user)
    session.commit()


def _assert_string_detail(resp: Any) -> str:
    """The CLI prints detail verbatim, so it must be a plain string."""
    detail = resp.json()["detail"]
    assert isinstance(detail, str)
    return detail


class TestMaxApiKeys:
    def _authed(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> tuple[TestClient, UserDB]:
        user = _setup_user(client, session)
        seed_project_for_user(session, user.id)
        return make_authed_client(user.id, session), user

    def test_create_blocks_at_cap(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, user = self._authed(client, session, make_authed_client)
        _set_caps(session, user, max_api_keys=1)

        first = authed.post(
            "/v1/api-keys", json={"name": "one", "project": TEST_PROJECT_ID}
        )
        assert first.status_code == 200, first.text

        second = authed.post(
            "/v1/api-keys", json={"name": "two", "project": TEST_PROJECT_ID}
        )
        assert second.status_code == 403
        detail = _assert_string_detail(second)
        assert "API key limit reached" in detail
        assert "max 1" in detail
        assert second.headers["X-RateLimit-Limit"] == "1"
        assert second.headers["X-RateLimit-Used"] == "1"
        assert "Retry-After" not in second.headers

        keys = session.exec(
            select(ApiKeyDB).where(ApiKeyDB.created_by == user.id)
        ).all()
        assert len(keys) == 1

    def test_bootstrap_mint_blocks_at_cap(
        self, client: TestClient, session: Session
    ) -> None:
        user = _setup_user(client, session)
        seed_project_for_user(session, user.id)
        _set_caps(session, user, max_api_keys=1)

        first = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        assert first.status_code == 200, first.text

        second = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        assert second.status_code == 403
        assert "API key limit reached" in _assert_string_detail(second)

    def test_zero_freezes_minting(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, user = self._authed(client, session, make_authed_client)
        _set_caps(session, user, max_api_keys=0)

        resp = authed.post(
            "/v1/api-keys", json={"name": "frozen", "project": TEST_PROJECT_ID}
        )
        assert resp.status_code == 403
        assert "API key limit reached" in _assert_string_detail(resp)
        assert session.exec(select(ApiKeyDB)).first() is None

    def test_null_column_takes_the_installation_default(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, user = self._authed(client, session, make_authed_client)
        assert user.max_api_keys is None

        statuses = [
            authed.post(
                "/v1/api-keys", json={"name": f"k{i}", "project": TEST_PROJECT_ID}
            ).status_code
            for i in range(6)
        ]
        assert statuses == [200] * 5 + [403]
        rejected = authed.post(
            "/v1/api-keys", json={"name": "sixth", "project": TEST_PROJECT_ID}
        )
        assert rejected.headers["X-RateLimit-Limit"] == "5"
        assert rejected.headers["X-RateLimit-Used"] == "5"

    def test_revoked_key_frees_slot(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, user = self._authed(client, session, make_authed_client)
        _set_caps(session, user, max_api_keys=1)

        first = authed.post(
            "/v1/api-keys", json={"name": "one", "project": TEST_PROJECT_ID}
        )
        assert first.status_code == 200
        assert authed.delete(f"/v1/api-keys/{first.json()['id']}").status_code == 200

        # Revocation hard-deletes the row, so the slot is live again.
        remake = authed.post(
            "/v1/api-keys", json={"name": "two", "project": TEST_PROJECT_ID}
        )
        assert remake.status_code == 200, remake.text


class TestMaxProjects:
    def test_create_blocks_at_cap(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        user = _setup_user(client, session)
        authed = make_authed_client(user.id, session)
        _set_caps(session, user, max_projects=1)

        first = authed.post("/v1/projects", json={"name": "first"})
        assert first.status_code == 201, first.text

        second = authed.post("/v1/projects", json={"name": "second"})
        assert second.status_code == 403
        detail = _assert_string_detail(second)
        assert "Project limit reached" in detail
        assert "max 1" in detail
        assert second.headers["X-RateLimit-Limit"] == "1"
        assert second.headers["X-RateLimit-Used"] == "1"
        assert "Retry-After" not in second.headers

        owned = [
            p
            for p in session.exec(select(ProjectDB)).all()
            if p.created_by == user.id
        ]
        assert len(owned) == 1

    def test_zero_freezes_creation(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        user = _setup_user(client, session)
        authed = make_authed_client(user.id, session)
        _set_caps(session, user, max_projects=0)

        resp = authed.post("/v1/projects", json={"name": "frozen"})
        assert resp.status_code == 403
        assert "Project limit reached" in _assert_string_detail(resp)
        assert session.exec(select(ProjectDB)).first() is None

    def test_null_column_takes_the_installation_default(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        user = _setup_user(client, session)
        authed = make_authed_client(user.id, session)
        assert user.max_projects is None

        statuses = [
            authed.post("/v1/projects", json={"name": f"p{i}"}).status_code
            for i in range(6)
        ]
        assert statuses == [201] * 5 + [403]
        rejected = authed.post("/v1/projects", json={"name": "sixth"})
        assert rejected.headers["X-RateLimit-Limit"] == "5"
        assert rejected.headers["X-RateLimit-Used"] == "5"


class TestProjectBootstrapCaps:
    def test_key_cap_denial_leaves_no_project_row(
        self, client: TestClient, session: Session
    ) -> None:
        user = _setup_user(client, session)
        # Frozen at zero keys, project cap unset: the key cap must fire
        # BEFORE the project row commits, or the denied mint strands an
        # orphan project.
        _set_caps(session, user, max_api_keys=0)

        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "Stranded Project",
            },
        )
        assert resp.status_code == 403
        assert "API key limit reached" in _assert_string_detail(resp)

        projects = [
            p
            for p in session.exec(select(ProjectDB)).all()
            if p.created_by == user.id
        ]
        assert projects == []

    def test_project_cap_denial(
        self, client: TestClient, session: Session
    ) -> None:
        user = _setup_user(client, session)
        _set_caps(session, user, max_projects=0)

        resp = client.post(
            "/v1/projects/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "name": "Frozen Project",
            },
        )
        assert resp.status_code == 403
        assert "Project limit reached" in _assert_string_detail(resp)
        assert session.exec(select(ProjectDB)).first() is None


class TestInstallationDefaults:
    """How a NULL column resolves, and how the env default itself is read."""

    def test_env_override_lowers_the_default(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        user = _setup_user(client, session)
        seed_project_for_user(session, user.id)
        authed = make_authed_client(user.id, session)
        monkeypatch.setenv("APO_DEFAULT_MAX_API_KEYS_PER_USER", "2")

        statuses = [
            authed.post(
                "/v1/api-keys", json={"name": f"k{i}", "project": TEST_PROJECT_ID}
            ).status_code
            for i in range(3)
        ]
        assert statuses == [200, 200, 403]
        assert authed.post(
            "/v1/api-keys", json={"name": "third", "project": TEST_PROJECT_ID}
        ).headers["X-RateLimit-Limit"] == "2"

    def test_env_zero_restores_unlimited(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        user = _setup_user(client, session)
        seed_project_for_user(session, user.id)
        authed = make_authed_client(user.id, session)
        monkeypatch.setenv("APO_DEFAULT_MAX_API_KEYS_PER_USER", "0")
        monkeypatch.setenv("APO_DEFAULT_MAX_PROJECTS_PER_USER", "0")

        for i in range(6):
            assert authed.post(
                "/v1/api-keys", json={"name": f"k{i}", "project": TEST_PROJECT_ID}
            ).status_code == 200
            assert authed.post("/v1/projects", json={"name": f"p{i}"}).status_code == 201

    def test_explicit_column_beats_the_env_default(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Column 10 under an env default of 2: the column wins on both
        # directions (higher than default here; test_zero_freezes_minting
        # covers lower-than-default).
        user = _setup_user(client, session)
        seed_project_for_user(session, user.id)
        authed = make_authed_client(user.id, session)
        monkeypatch.setenv("APO_DEFAULT_MAX_API_KEYS_PER_USER", "2")
        _set_caps(session, user, max_api_keys=10)

        statuses = [
            authed.post(
                "/v1/api-keys", json={"name": f"k{i}", "project": TEST_PROJECT_ID}
            ).status_code
            for i in range(10)
        ]
        assert statuses == [200] * 10

    @pytest.mark.parametrize("bad_value", ["", "abc", "-1", "3.5"])
    def test_invalid_default_cap_env_fails_fast(
        self, monkeypatch: pytest.MonkeyPatch, bad_value: str
    ) -> None:
        # create_app validates at startup; an invalid value must name the
        # variable, not read as 0 and silently lift the cap everywhere.
        from apo.services.user_quotas import load_default_creation_caps

        monkeypatch.setenv("APO_DEFAULT_MAX_API_KEYS_PER_USER", bad_value)
        with pytest.raises(ValueError) as exc_info:
            load_default_creation_caps()
        assert "APO_DEFAULT_MAX_API_KEYS_PER_USER" in str(exc_info.value)

    def test_invalid_project_default_cap_env_fails_fast(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from apo.services.user_quotas import load_default_creation_caps

        monkeypatch.setenv("APO_DEFAULT_MAX_PROJECTS_PER_USER", "nope")
        with pytest.raises(ValueError) as exc_info:
            load_default_creation_caps()
        assert "APO_DEFAULT_MAX_PROJECTS_PER_USER" in str(exc_info.value)
