# pyright: reportAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownVariableType=false, reportUnusedParameter=false

"""Authorization on /v1/admin/reprice.

An installation admin may reprice any scope. A project owner/admin may reprice
their own project through a browser session: it only recomputes that project's
stored costs from the global price table. Unscoped reprices, other projects,
lower roles and project API keys stay refused.
"""

from collections.abc import Iterator
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.auth import hash_password
from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB
from apo.routes import admin as admin_routes


def _make_user(session: Session, *, is_admin: bool = False) -> UserDB:
    user = UserDB(
        email=f"user-{uuid4().hex[:8]}@test.com",
        name="Test User",
        password_hash=hash_password("SecretPass123"),
        is_admin=is_admin,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _make_project(session: Session, project_id: str, user_id: str, role: str) -> None:
    now = datetime.now(timezone.utc)
    if session.get(ProjectDB, project_id) is None:
        session.add(ProjectDB(id=project_id, name=project_id, created_by=user_id, created_at=now))
    session.add(
        ProjectMembershipDB(project_id=project_id, user_id=user_id, role=role, created_at=now, updated_at=now)
    )
    session.commit()


@pytest.fixture(autouse=True)
def _no_reprice_work(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The route runs reprice_calls on a thread against the real engine; these
    tests are about who may start and poll a job, not what it computes."""

    def _finish(job_id: str, req: admin_routes.RepriceRequest) -> None:
        admin_routes._reprice_jobs[job_id] = {"status": "done", "summary": {}, "error": None, "project": req.project}

    monkeypatch.setattr(admin_routes, "_run_reprice_job", _finish)
    yield
    admin_routes._reprice_jobs.clear()


class TestProjectScopedReprice:
    @pytest.mark.parametrize("role", ["owner", "admin"])
    def test_project_admin_can_reprice_and_poll_own_project(
        self, session: Session, make_authed_client, role: str  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session)
        _make_project(session, "proj-a", user.id, role)
        authed = make_authed_client(user.id, session, is_admin=False)

        start = authed.post("/v1/admin/reprice", json={"project": "proj-a", "dry_run": True})
        assert start.status_code == 200
        poll = authed.get(f"/v1/admin/reprice/{start.json()['job_id']}")
        assert poll.status_code == 200
        assert poll.json()["project"] == "proj-a"

    @pytest.mark.parametrize("role", ["member", "viewer"])
    def test_lower_project_roles_are_refused(
        self, session: Session, make_authed_client, role: str  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session)
        _make_project(session, "proj-a", user.id, role)
        authed = make_authed_client(user.id, session, is_admin=False)

        resp = authed.post("/v1/admin/reprice", json={"project": "proj-a"})
        assert resp.status_code == 403

    def test_project_admin_cannot_reprice_another_project(
        self, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session)
        other = _make_user(session)
        _make_project(session, "proj-a", user.id, "owner")
        _make_project(session, "proj-b", other.id, "owner")
        authed = make_authed_client(user.id, session, is_admin=False)

        resp = authed.post("/v1/admin/reprice", json={"project": "proj-b"})
        assert resp.status_code == 403

    def test_project_admin_cannot_reprice_every_project(
        self, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session)
        _make_project(session, "proj-a", user.id, "owner")
        authed = make_authed_client(user.id, session, is_admin=False)

        resp = authed.post("/v1/admin/reprice", json={})
        assert resp.status_code == 401

    def test_project_admin_cannot_poll_another_projects_job(
        self, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session)
        other = _make_user(session)
        _make_project(session, "proj-a", user.id, "owner")
        _make_project(session, "proj-b", other.id, "owner")
        job_id = make_authed_client(other.id, session, is_admin=False).post(
            "/v1/admin/reprice", json={"project": "proj-b"}
        ).json()["job_id"]

        resp = make_authed_client(user.id, session, is_admin=False).get(f"/v1/admin/reprice/{job_id}")
        assert resp.status_code == 403

    def test_project_admin_cannot_poll_an_unscoped_job(
        self, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        installation_admin = _make_user(session, is_admin=True)
        user = _make_user(session)
        _make_project(session, "proj-a", user.id, "owner")
        job_id = make_authed_client(installation_admin.id, session).post(
            "/v1/admin/reprice", json={}
        ).json()["job_id"]

        resp = make_authed_client(user.id, session, is_admin=False).get(f"/v1/admin/reprice/{job_id}")
        assert resp.status_code == 401

    def test_project_api_key_is_refused_even_for_its_own_project(
        self, session: Session, make_api_key_client  # type: ignore[no-untyped-def]
    ) -> None:
        user = _make_user(session)
        _make_project(session, "proj-a", user.id, "owner")
        keyed = make_api_key_client(user.id, "proj-a", session)

        resp = keyed.post("/v1/admin/reprice", json={"project": "proj-a"})
        assert resp.status_code == 401


class TestInstallationAdminReprice:
    def test_installation_admin_can_reprice_every_project(
        self, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        admin = _make_user(session, is_admin=True)
        authed = make_authed_client(admin.id, session)

        start = authed.post("/v1/admin/reprice", json={"dry_run": True})
        assert start.status_code == 200
        assert authed.get(f"/v1/admin/reprice/{start.json()['job_id']}").status_code == 200

    def test_installation_admin_gets_404_for_unknown_job(
        self, session: Session, make_authed_client  # type: ignore[no-untyped-def]
    ) -> None:
        admin = _make_user(session, is_admin=True)
        assert make_authed_client(admin.id, session).get("/v1/admin/reprice/nope").status_code == 404
