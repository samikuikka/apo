# pyright: reportAny=false, reportExplicitAny=false, reportUnusedCallResult=false

"""Boundary tests: legacy ingestion surfaces.

Red-first companion to ``test_project_authorization_boundary.py``. Before
this closure, the payload ``project`` field was trusted as write authority
on the ingestion route.

All tests exercise registered routes through TestClient with the standard
credential fixtures (``make_authed_client`` / ``make_api_key_client``).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session, select

from apo.models.db import (
    LoggedCallDB,
    ProjectDB,
    ProjectMembershipDB,
    RunDB,
    RunMetricDB,
    UserDB,
)

_PROJECT_A = "proj-ing-a"
_PROJECT_B = "proj-ing-b"
_USER_ALICE = "user-ing-alice"  # owner of A and B (multi-project creator)
_USER_BOB = "user-ing-bob"  # member of B only


def _seed_user(session: Session, user_id: str) -> UserDB:
    user = UserDB(id=user_id, email=f"{user_id}@test", name=user_id, password_hash="x")
    session.add(user)
    session.commit()
    return user


def _seed_project(session: Session, project_id: str, owner_id: str) -> None:
    now = datetime.now(timezone.utc)
    session.add(
        ProjectDB(id=project_id, name=project_id, created_by=owner_id, created_at=now)
    )
    session.add(
        ProjectMembershipDB(
            project_id=project_id, user_id=owner_id, role="owner",
            created_at=now, updated_at=now,
        )
    )
    session.commit()


def _seed_run(
    session: Session,
    *,
    trace_id: str,
    project: str,
    environment: str = "test",
) -> RunDB:
    run = RunDB(
        id=trace_id,
        project=project,
        environment=environment,
        created_at=datetime.now(timezone.utc),
    )
    session.add(run)
    session.commit()
    return run


def _seed_call(
    session: Session,
    *,
    call_id: str,
    trace_id: str,
    project: str,
    output: str,
) -> LoggedCallDB:
    call = LoggedCallDB(
        id=call_id,
        run_id=trace_id,
        project=project,
        task_id=f"task-{project}",
        step_name="gen",
        model="test-model",
        observation_type="GENERATION",
        input=[],
        messages=[],
        output=output,
        created_at=datetime.now(timezone.utc),
    )
    session.add(call)
    session.commit()
    return call


def _seed_world(session: Session) -> None:
    """Alice owns A and B; Bob is a member of B only."""
    _seed_user(session, _USER_ALICE)
    _seed_user(session, _USER_BOB)
    _seed_project(session, _PROJECT_A, _USER_ALICE)
    _seed_project(session, _PROJECT_B, _USER_ALICE)
    now = datetime.now(timezone.utc)
    session.add(
        ProjectMembershipDB(
            project_id=_PROJECT_B, user_id=_USER_BOB, role="member",
            created_at=now, updated_at=now,
        )
    )
    session.commit()


def _runs_in_project(session: Session, project: str) -> list[RunDB]:
    return list(
        session.exec(select(RunDB).where(RunDB.project == project)).all()
    )


def _run_event(
    event_id: str,
    event_type: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": event_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": event_type,
        "body": body,
    }


class TestLegacyIngestionBoundary:
    """POST /api/v1/ingestion: payload project never authorizes a write."""

    def test_api_key_cannot_ingest_into_unbound_project(
        self, session: Session, make_api_key_client: Any
    ) -> None:
        _seed_world(session)
        client = make_api_key_client(_USER_ALICE, _PROJECT_A, session)

        response = client.post(
            "/api/v1/ingestion",
            json={
                "batch": [
                    _run_event(
                        "evt-1",
                        "run-create",
                        {"id": "trace-cross-1", "project": _PROJECT_B},
                    )
                ]
            },
        )

        assert response.status_code == 200
        errors = response.json()["errors"]
        assert len(errors) == 1
        assert _runs_in_project(session, _PROJECT_B) == []
        assert _runs_in_project(session, _PROJECT_A) == []

    def test_api_key_without_body_project_writes_bound_project(
        self, session: Session, make_api_key_client: Any
    ) -> None:
        _seed_world(session)
        client = make_api_key_client(_USER_ALICE, _PROJECT_A, session)

        response = client.post(
            "/api/v1/ingestion",
            json={"batch": [_run_event("evt-1", "run-create", {"id": "trace-a-1"})]},
        )

        assert response.status_code == 200
        assert response.json()["errors"] == []
        runs_a = _runs_in_project(session, _PROJECT_A)
        assert [run.id for run in runs_a] == ["trace-a-1"]

    def test_session_non_member_cannot_ingest_into_project(
        self, session: Session, make_authed_client: Any
    ) -> None:
        _seed_world(session)
        client = make_authed_client(_USER_BOB, session)

        response = client.post(
            "/api/v1/ingestion",
            json={
                "batch": [
                    _run_event(
                        "evt-1",
                        "run-create",
                        {"id": "trace-cross-2", "project": _PROJECT_A},
                    )
                ]
            },
        )

        assert response.status_code == 200
        assert len(response.json()["errors"]) == 1
        assert _runs_in_project(session, _PROJECT_A) == []

    def test_api_key_cannot_score_other_projects_trace(
        self, session: Session, make_api_key_client: Any
    ) -> None:
        _seed_world(session)
        _seed_run(session, trace_id="trace-a-score", project=_PROJECT_A)
        client = make_api_key_client(_USER_ALICE, _PROJECT_B, session)

        response = client.post(
            "/api/v1/ingestion",
            json={
                "batch": [
                    _run_event(
                        "evt-score",
                        "score-create",
                        {"trace_id": "trace-a-score", "name": "q", "value": 1},
                    )
                ]
            },
        )

        assert response.status_code == 200
        assert len(response.json()["errors"]) == 1
        metrics = list(
            session.exec(
                select(RunMetricDB).where(RunMetricDB.run_id == "trace-a-score")
            ).all()
        )
        assert metrics == []

    def test_call_update_cannot_touch_other_projects_span(
        self, session: Session, make_api_key_client: Any
    ) -> None:
        _seed_world(session)
        _seed_run(session, trace_id="trace-a-span", project=_PROJECT_A)
        _seed_call(
            session,
            call_id="call-a-span",
            trace_id="trace-a-span",
            project=_PROJECT_A,
            output="original",
        )
        client = make_api_key_client(_USER_ALICE, _PROJECT_B, session)

        response = client.post(
            "/api/v1/ingestion",
            json={
                "batch": [
                    _run_event(
                        "evt-update",
                        "call-update",
                        {"id": "call-a-span", "project": _PROJECT_B, "output": "pwned"},
                    )
                ]
            },
        )

        assert response.status_code == 200
        call = session.exec(
            select(LoggedCallDB).where(
                LoggedCallDB.id == "call-a-span",
                LoggedCallDB.project == _PROJECT_A,
            )
        ).first()
        assert call is not None
        assert call.output == "original"
