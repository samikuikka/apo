# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnusedFunction=false, reportUnusedCallResult=false

"""Per-user creation count caps (max_api_keys, max_projects).

NULL = unlimited, 0 = creation frozen, N = cap. Enforced on POST
/v1/api-keys, both bootstrap mints, POST /v1/projects, and
POST /v1/projects/bootstrap before any write, so a key-cap denial
never strands an orphan project row. Denials are 403 with a
plain-string detail (the CLI renders detail verbatim).
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

        # The denied mint wrote nothing: still exactly one key row.
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

    def test_null_is_unlimited(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, user = self._authed(client, session, make_authed_client)
        assert user.max_api_keys is None

        for i in range(3):
            resp = authed.post(
                "/v1/api-keys", json={"name": f"k{i}", "project": TEST_PROJECT_ID}
            )
            assert resp.status_code == 200, resp.text

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

    def test_null_is_unlimited(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        user = _setup_user(client, session)
        authed = make_authed_client(user.id, session)
        assert user.max_projects is None

        for i in range(3):
            resp = authed.post("/v1/projects", json={"name": f"p{i}"})
            assert resp.status_code == 201, resp.text


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
