"""Dev sign-in and dev-workspace provisioning tests."""

# pyright: reportAny=false, reportUnusedParameter=false

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectMembershipDB,
    ProjectDB,
    RunDB,
    UserDB,
)
from apo.services.dev_workspace import (
    DEV_SEED_MODEL_DEFAULT,
    DEV_USER_EMAIL,
    ensure_dev_workspace,
)


def _set_env(monkeypatch: MonkeyPatch, enabled: str) -> None:
    monkeypatch.setenv("DEV_SIGNIN_ENABLED", enabled)
    monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")


def test_available_disabled_reports_false(monkeypatch: MonkeyPatch, client: TestClient):
    _set_env(monkeypatch, "false")
    res = client.get("/auth/dev-signin/available")
    assert res.status_code == 200
    assert res.json() == {"enabled": False, "landing_path": None, "project_id": None}


def test_available_enabled_reports_landing(monkeypatch: MonkeyPatch, client: TestClient):
    _set_env(monkeypatch, "true")
    res = client.get("/auth/dev-signin/available")
    assert res.status_code == 200
    body: dict[str, object] = res.json()
    assert body["enabled"] is True
    assert body["landing_path"] == "/project/agent-demo/tasks"
    assert body["project_id"] == "agent-demo"


def test_signin_404_when_disabled(monkeypatch: MonkeyPatch, client: TestClient):
    _set_env(monkeypatch, "false")
    res = client.post("/auth/dev-signin")
    assert res.status_code == 404


def test_signin_provisions_workspace_idempotently(
    monkeypatch: MonkeyPatch, client: TestClient, session: Session
):
    _set_env(monkeypatch, "true")

    first = client.post("/auth/dev-signin")
    assert first.status_code == 200
    body = first.json()
    assert body["email"] == DEV_USER_EMAIL
    assert body["is_admin"] is False
    assert body["landing_path"] == "/project/agent-demo/tasks"

    second = client.post("/auth/dev-signin")
    assert second.status_code == 200
    assert second.json()["id"] == body["id"]

    user = session.exec(
        select(UserDB).where(UserDB.email == DEV_USER_EMAIL)
    ).one()
    assert user.is_active is True

    project = session.get(ProjectDB, "agent-demo")
    assert project is not None

    membership = session.exec(
        select(ProjectMembershipDB).where(
            ProjectMembershipDB.project_id == "agent-demo",
            ProjectMembershipDB.user_id == user.id,
        )
    ).one()
    assert membership.role == "owner"

    # One seeded batch with task runs and traces; a second sign-in must not
    # duplicate it.
    batches = session.exec(
        select(AgentTaskBatchRunDB).where(AgentTaskBatchRunDB.project == "agent-demo")
    ).all()
    assert len(batches) == 1
    assert batches[0].status == "completed"

    task_runs = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batches[0].id)
    ).all()
    assert len(task_runs) >= 3
    assert {run.pass_result for run in task_runs} == {True, False}
    # Seeded runs must use the canonical run lifecycle — "completed" is a
    # batch status and renders as a bogus "pending" in the dashboard.
    for run in task_runs:
        assert run.status == ("passed" if run.pass_result else "failed")
        assert run.trace_persistence_status == "persisted"
    assert all(
        run.configured_model == DEV_SEED_MODEL_DEFAULT for run in task_runs
    )

    traces = session.exec(
        select(RunDB).where(RunDB.project == "agent-demo")
    ).all()
    assert len(traces) == len(task_runs)
    for run in task_runs:
        linked = [t for t in traces if t.task_run_id == run.id]
        assert len(linked) == 1
        assert run.trace_run_id == linked[0].id


def test_dev_user_cannot_password_login(
    monkeypatch: MonkeyPatch, client: TestClient, session: Session
):
    _set_env(monkeypatch, "true")
    assert client.post("/auth/dev-signin").status_code == 200

    res = client.post(
        "/auth/verify-password",
        json={"email": DEV_USER_EMAIL, "password": "whatever"},
    )
    assert res.status_code == 401


def test_provisioning_does_not_touch_shared_demo(
    monkeypatch: MonkeyPatch, client: TestClient, session: Session
):
    _set_env(monkeypatch, "true")
    assert client.post("/auth/dev-signin").status_code == 200

    demo_batches = session.exec(
        select(AgentTaskBatchRunDB).where(AgentTaskBatchRunDB.project == "demo")
    ).all()
    assert demo_batches == []


def test_default_profile_enables_dev_signin(monkeypatch: MonkeyPatch, client: TestClient):
    monkeypatch.delenv("DEV_SIGNIN_ENABLED", raising=False)
    monkeypatch.delenv("APO_DEPLOYMENT_PROFILE", raising=False)
    res = client.get("/auth/dev-signin/available")
    assert res.status_code == 200
    assert res.json()["enabled"] is True


def test_release_profile_defaults_off(monkeypatch: MonkeyPatch, client: TestClient):
    monkeypatch.delenv("DEV_SIGNIN_ENABLED", raising=False)
    monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
    res = client.get("/auth/dev-signin/available")
    assert res.status_code == 200
    assert res.json()["enabled"] is False


def test_ensure_dev_workspace_returns_user_directly(
    monkeypatch: MonkeyPatch, session: Session
):
    _set_env(monkeypatch, "true")
    user = ensure_dev_workspace(session)
    assert user.email == DEV_USER_EMAIL
