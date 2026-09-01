# pyright: reportAny=false, reportExplicitAny=false, reportUnusedCallResult=false

"""Boundary tests: the final adversarial-pass gaps.

Companion to ``test_project_authorization_boundary.py`` and
``test_ingestion_project_boundary.py``. Each test pins one hole found in
the 2026-08-14 adversarial re-review:

- POST /v1/agent-task-runs/{id}/result performed no authorization at all
  (cross-Project verdict/transcript overwrite + read-back)
- projects.py authorized by creator membership only (a Project-A key could
  read, wipe, or DELETE Project B when the creator belonged to both)
- agent_task_views.py used require_project_member (no key binding)
- score-config validation leaked another Project's rubric bounds through
  error strings and persisted dangling cross-Project config references
- custom-metric rows were filed under the "default" Project
- service tokens could PATCH any run in their Project, not just their own
- any authenticated user could force-reseed the shared demo workspace
"""

from __future__ import annotations

import pytest

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, override

from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from sqlmodel import Session, select
from starlette.middleware.base import BaseHTTPMiddleware

from apo.api import app
from apo.db import get_session
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectMembershipDB,
    RunDB,
    RunMetricDB,
    ScoreConfigDB,
    UserDB,
)

_PROJECT_A = "proj-final-a"
_PROJECT_B = "proj-final-b"
_USER_ALICE = "user-final-alice"  # owner of A and B (multi-project creator)
_USER_BOB = "user-final-bob"  # member of B only


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _seed_user(session: Session, user_id: str) -> None:
    session.add(UserDB(id=user_id, email=f"{user_id}@test", name=user_id, password_hash="x"))


def _seed_world(session: Session) -> None:
    """Alice owns A and B; Bob is a member of B only."""
    now = _now()
    _seed_user(session, _USER_ALICE)
    _seed_user(session, _USER_BOB)
    session.commit()
    for project_id in (_PROJECT_A, _PROJECT_B):
        session.add(
            ProjectDB(id=project_id, name=project_id, created_by=_USER_ALICE, created_at=now)
        )
        session.add(
            ProjectMembershipDB(
                project_id=project_id, user_id=_USER_ALICE, role="owner",
                created_at=now, updated_at=now,
            )
        )
    session.add(
        ProjectMembershipDB(
            project_id=_PROJECT_B, user_id=_USER_BOB, role="member",
            created_at=now, updated_at=now,
        )
    )
    session.commit()


def _seed_task_run(
    session: Session,
    *,
    run_id: str,
    batch_id: str,
    project: str,
    status: str = "running",
) -> AgentTaskRunDB:
    now = _now()
    session.add(
        AgentTaskBatchRunDB(
            id=batch_id, project=project, created_at=now, status="running",
            total_tasks=1, task_root="/t", environment="default", selection_type="task",
        )
    )
    session.flush()
    run = AgentTaskRunDB(
        id=run_id, batch_run_id=batch_id, task_id=f"evals/{run_id}",
        task_path=f"/t/evals/{run_id}", status=status, pass_result=None,
        started_at=now,
    )
    session.add(run)
    session.commit()
    return run


def _seed_trace_run(session: Session, trace_id: str, project: str) -> RunDB:
    run = RunDB(
        id=trace_id,
        project=project,
        environment="test",
        created_at=_now(),
    )
    session.add(run)
    session.commit()
    return run


def _client_with_state(
    session: Session, **state: Any
) -> TestClient:
    """TestClient whose middleware injects arbitrary request.state values."""

    class InjectStateMiddleware(BaseHTTPMiddleware):
        @override
        async def dispatch(
            self,
            request: Request,
            call_next: Callable[[Request], Awaitable[Response]],
        ) -> Response:
            for key, value in state.items():
                setattr(request.state, key, value)
            return await call_next(request)

    new_app = FastAPI()
    new_app.include_router(app.router)
    new_app.add_middleware(InjectStateMiddleware)

    def _session_override() -> Session:
        return session

    new_app.dependency_overrides[get_session] = _session_override
    return TestClient(new_app)


def _session_client(session: Session, user_id: str, *, is_admin: bool = False) -> TestClient:
    return _client_with_state(session, user_id=user_id, is_admin=is_admin)


def _api_key_client(session: Session, creator: str, bound_project: str) -> TestClient:
    return _client_with_state(
        session,
        user_id=creator,
        auth_method="api_key",
        project=bound_project,
        api_key_scope="full",
        api_key_id="test-key",
    )


def _service_token_client(
    session: Session, project: str, task_run_id: str
) -> TestClient:
    return _client_with_state(
        session,
        auth_method="service_token",
        project=project,
        service_task_run_id=task_run_id,
    )


# ---------------------------------------------------------------------------
# 1. Task-run result authorization
# ---------------------------------------------------------------------------


class TestTaskRunResultAuthorization:
    def test_cross_project_session_report_is_opaque(
        self, session: Session, make_authed_client: Any
    ) -> None:
        _seed_world(session)
        run = _seed_task_run(session, run_id="run-a-1", batch_id="batch-a-1", project=_PROJECT_A)
        client = make_authed_client(_USER_BOB, session)

        response = client.post(
            f"/v1/agent-task-runs/{run.id}/result",
            json={"pass_result": True, "checks": []},
        )

        assert response.status_code == 404
        session.refresh(run)
        assert run.status == "running"
        assert run.pass_result is None

    def test_service_token_is_exact_run_scoped(
        self, session: Session
    ) -> None:
        _seed_world(session)
        _seed_task_run(session, run_id="run-a-1", batch_id="batch-a-1", project=_PROJECT_A)
        run_a2 = _seed_task_run(
            session, run_id="run-a-2", batch_id="batch-a-2", project=_PROJECT_A
        )
        client = _service_token_client(session, _PROJECT_A, "run-a-1")

        response = client.post(
            f"/v1/agent-task-runs/{run_a2.id}/result",
            json={"pass_result": True, "checks": []},
        )

        assert response.status_code == 404
        session.refresh(run_a2)
        assert run_a2.status == "running"

    def test_member_can_report_own_project_run(
        self, session: Session, make_authed_client: Any
    ) -> None:
        _seed_world(session)
        run = _seed_task_run(session, run_id="run-a-1", batch_id="batch-a-1", project=_PROJECT_A)
        client = make_authed_client(_USER_ALICE, session)

        response = client.post(
            f"/v1/agent-task-runs/{run.id}/result",
            json={"pass_result": True, "checks": []},
        )

        assert response.status_code == 200
        session.refresh(run)
        assert run.status == "passed"
        assert run.pass_result is True


# ---------------------------------------------------------------------------
# 2. projects.py Credential Authority
# ---------------------------------------------------------------------------


class TestProjectsCredentialAuthority:
    def test_key_cannot_read_foreign_project_detail(
        self, session: Session
    ) -> None:
        _seed_world(session)
        client = _api_key_client(session, _USER_ALICE, _PROJECT_A)

        response = client.get(f"/v1/projects/{_PROJECT_B}")

        assert response.status_code == 403

    def test_key_list_shows_only_bound_project(
        self, session: Session
    ) -> None:
        _seed_world(session)
        client = _api_key_client(session, _USER_ALICE, _PROJECT_A)

        response = client.get("/v1/projects")

        assert response.status_code == 200
        ids = [project["id"] for project in response.json()]
        assert _PROJECT_A in ids
        assert _PROJECT_B not in ids

    def test_session_list_shows_all_memberships(
        self, session: Session, make_authed_client: Any
    ) -> None:
        _seed_world(session)
        client = make_authed_client(_USER_ALICE, session)

        response = client.get("/v1/projects")

        assert response.status_code == 200
        ids = [project["id"] for project in response.json()]
        assert _PROJECT_A in ids
        assert _PROJECT_B in ids

    def test_key_cannot_reset_or_delete_foreign_project(
        self, session: Session
    ) -> None:
        _seed_world(session)
        client = _api_key_client(session, _USER_ALICE, _PROJECT_A)

        reset = client.post(f"/v1/projects/{_PROJECT_B}/reset-data")
        assert reset.status_code == 403

        delete = client.delete(f"/v1/projects/{_PROJECT_B}")
        assert delete.status_code == 403

        # Project B survives both attempts untouched.
        assert session.get(ProjectDB, _PROJECT_B) is not None


# ---------------------------------------------------------------------------
# 3. Task views Credential Authority
# ---------------------------------------------------------------------------


class TestTaskViewsCredentialAuthority:
    def test_key_cannot_read_foreign_project_views(
        self, session: Session
    ) -> None:
        _seed_world(session)
        client = _api_key_client(session, _USER_ALICE, _PROJECT_B)

        response = client.get(f"/v1/projects/{_PROJECT_A}/task-views")

        assert response.status_code == 403


# ---------------------------------------------------------------------------
# 4. Score-config oracle
# ---------------------------------------------------------------------------


class TestScoreConfigOracle:
    def test_foreign_config_is_not_found_not_leaked(
        self, session: Session, make_authed_client: Any
    ) -> None:
        _seed_world(session)
        _seed_trace_run(session, "trace-b-oracle", _PROJECT_B)
        config = ScoreConfigDB(
            project=_PROJECT_A,
            name="accuracy",
            data_type="NUMERIC",
            min_value=0.0,
            max_value=4.0,
        )
        session.add(config)
        session.commit()
        client = make_authed_client(_USER_BOB, session)

        response = client.post(
            f"/api/v1/traces/trace-b-oracle/scores",
            json={"name": "accuracy", "value": 100.0, "config_id": config.id},
        )

        assert response.status_code == 400
        detail = str(response.json().get("detail", ""))
        assert "not found" in detail
        assert "4.0" not in detail  # A's rubric bounds must not leak
        metrics = list(
            session.exec(
                select(RunMetricDB).where(RunMetricDB.run_id == "trace-b-oracle")
            ).all()
        )
        assert metrics == []


# ---------------------------------------------------------------------------
# 5. Custom-metric Project stamping
# ---------------------------------------------------------------------------


class TestCustomMetricProjectStamping:
    def test_custom_metrics_land_in_run_project(
        self, session: Session, make_authed_client: Any
    ) -> None:
        _seed_world(session)
        _seed_trace_run(session, "trace-a-metric", _PROJECT_A)
        client = make_authed_client(_USER_ALICE, session)

        response = client.post(
            "/v1/runs/trace-a-metric/custom-metrics",
            json={"metrics": [{"name": "helpfulness", "score": 5.0}]},
        )

        assert response.status_code == 200
        metric = session.exec(
            select(RunMetricDB).where(RunMetricDB.run_id == "trace-a-metric")
        ).one()
        assert metric.project == _PROJECT_A


# ---------------------------------------------------------------------------
# 6. Service-token run patch subject binding
# ---------------------------------------------------------------------------


class TestRunPatchSubjectBinding:
    def _seed_claimed_token_run(self, session: Session) -> None:
        _seed_world(session)
        _seed_trace_run(session, "trace-b-own", _PROJECT_B)
        _seed_trace_run(session, "trace-b-other", _PROJECT_B)
        run = _seed_task_run(
            session, run_id="run-b-exec", batch_id="batch-b-exec", project=_PROJECT_B
        )
        run.trace_run_id = "trace-b-own"
        session.add(run)
        session.commit()

    def test_token_patches_only_its_claimed_run(self, session: Session) -> None:
        self._seed_claimed_token_run(session)
        client = _service_token_client(session, _PROJECT_B, "run-b-exec")

        own = client.patch("/v1/runs/trace-b-own", json={"call_count": 3})
        assert own.status_code == 200

        other = client.patch("/v1/runs/trace-b-other", json={"call_count": 3})
        assert other.status_code == 403


# ---------------------------------------------------------------------------
# 7. Demo workspace stays read-only (the executor seed route was retired;
#    the permanent guard is require_project_not_demo)
# ---------------------------------------------------------------------------


class TestDemoWorkspaceStaysReadOnly:
    def test_mutation_on_demo_project_is_rejected(self, session: Session) -> None:
        from apo.services.demo_workspace import (
            DEMO_READ_ONLY_STATUS,
            require_project_not_demo,
        )
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            require_project_not_demo("demo")
        assert exc.value.status_code == DEMO_READ_ONLY_STATUS  # pyright: ignore[reportAttributeAccessIssue]
