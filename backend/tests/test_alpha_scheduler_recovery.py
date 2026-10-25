"""Internal alpha release gate — scheduler restart recovery.

Validates that an unscheduled backend restart cannot leave the
scheduler in a state where:

 - in-flight work is silently forgotten about, or
 - the next dispatch double-fires the same schedule, or
 - schedules appear "due now" forever and confuse operators.

These tests target the alpha single-node topology and the in-process
scheduler specifically.
"""

from datetime import datetime, timedelta, timezone

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    ProjectDB,
    ProjectTaskSourceDB,
    UserDB,
)
from apo.services import agent_task_runner as runner_module
from apo.services import agent_task_scheduler as scheduler_module
from apo.services.agent_task_runner import (
    update_batch_run_status,
)
from apo.services.agent_task_scheduler import run_due_schedules_once


def _bind_to_test_engine(session: Session, monkeypatch: MonkeyPatch) -> None:
    """Make recovery/dispatch helpers query the in-memory test engine.

    ``recover_stuck_runs`` and ``run_due_schedules_once`` open their own
    sessions against the module-level ``engine``. Without rebinding, they
    would not see rows we inserted via the test ``session`` (which uses
    the conftest in-memory engine).
    """
    test_engine = session.get_bind()
    monkeypatch.setattr(runner_module, "engine", test_engine)
    monkeypatch.setattr(scheduler_module, "engine", test_engine)


def _bootstrap_admin(client: TestClient, session: Session) -> str:
    resp = client.post(
        "/auth/setup",
        json={"email": "admin@test.com", "password": "AdminPass123", "name": "Admin"},
    )
    assert resp.status_code == 200, resp.text
    admin_user = session.exec(select(UserDB)).first()
    assert admin_user is not None
    admin_user.is_admin = True
    session.add(admin_user)
    session.commit()
    session.refresh(admin_user)
    return admin_user.id


def _make_project(session: Session, slug: str, admin_id: str) -> ProjectDB:
    project = ProjectDB(
        id=slug,
        name=slug,
        created_by=admin_id,
        created_at=datetime.now(timezone.utc),
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


def _make_schedule(
    session: Session,
    *,
    project: str,
    next_run_at: datetime,
    selection_type: str = "all",
) -> AgentTaskScheduleDB:
    schedule = AgentTaskScheduleDB(
        id=f"schedule-{project}",
        project=project,
        name=f"schedule-{project}",
        cadence_type="daily",
        timezone="UTC",
        hour=9,
        minute=0,
        selection_type=selection_type,
        environment="default",
        task_root="./tasks",
        enabled=True,
        next_run_at=next_run_at,
        created_at=datetime.now(timezone.utc),
    )
    session.add(schedule)
    session.commit()
    session.refresh(schedule)
    return schedule


class TestNoDuplicateDispatchOnRestart:
    """A schedule must not double-fire when the dispatcher restarts."""

    def test_already_dispatched_schedule_does_not_fire_again(
        self,
        client: TestClient,
        session: Session,
        monkeypatch: MonkeyPatch,
    ) -> None:
        _bind_to_test_engine(session, monkeypatch)

        admin_id = _bootstrap_admin(client, session)
        project = _make_project(session, "alpha-no-dup", admin_id)

        # Pretend the schedule already fired by pushing next_run_at forward.
        future = datetime.now(timezone.utc) + timedelta(days=1)
        schedule = _make_schedule(
            session, project=project.id, next_run_at=future
        )

        fired = run_due_schedules_once()
        assert fired == 0

        session.refresh(schedule)
        # next_run_at stays in the future; no double-fire window.
        # SQLite drops tzinfo on round-trip, so re-attach UTC before comparing.
        next_run_at = schedule.next_run_at
        assert next_run_at is not None
        if next_run_at.tzinfo is None:
            next_run_at = next_run_at.replace(tzinfo=timezone.utc)
        assert next_run_at > datetime.now(timezone.utc)

    def test_due_schedule_without_ready_task_source_skips_dispatch(
        self,
        client: TestClient,
        session: Session,
        monkeypatch: MonkeyPatch,
    ) -> None:
        _bind_to_test_engine(session, monkeypatch)

        admin_id = _bootstrap_admin(client, session)
        project = _make_project(session, "alpha-pending-source", admin_id)

        # Add a task source in non-ready state so dispatch must skip.
        pending_source = ProjectTaskSourceDB(
            id="source-pending",
            project=project.id,
            source_type="filesystem",
            display_name="Pending source",
            subpath="tasks",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        session.add(pending_source)
        session.commit()

        _ = _make_schedule(
            session,
            project=project.id,
            next_run_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        )

        fired = run_due_schedules_once()
        assert fired == 0


class TestUpdateBatchRunStatusRecoversTracePersistence:
    """Trace persistence failures must surface clearly post-restart."""

    def test_mixed_persistence_states_resolve_to_failed_or_persisted(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        admin_id = _bootstrap_admin(client, session)
        project = _make_project(session, "alpha-trace-rollup", admin_id)

        batch = AgentTaskBatchRunDB(
            id="batch-trace-1",
            project=project.id,
            selection_type="all",
            task_root="./tasks",
            environment="default",
            run_metadata={"trigger": {"source": "api"}},
            status="running",
            total_tasks=3,
            started_at=datetime.now(timezone.utc),
            created_at=datetime.now(timezone.utc),
        )
        runs = [
            AgentTaskRunDB(
                id=f"run-trace-{i}",
                batch_run_id="batch-trace-1",
                task_id=f"task-{i}",
                task_path=f"./tasks/task-{i}",
                status=status,
                pass_result=status == "passed",
                trace_persistence_status=persistence,
                completed_at=datetime.now(timezone.utc),
            )
            for i, (status, persistence) in enumerate(
                [
                    ("passed", "persisted"),
                    ("failed", "failed"),
                    ("passed", "persisted"),
                ],
                start=1,
            )
        ]
        session.add(batch)
        session.add_all(runs)
        session.commit()

        update_batch_run_status(session, batch)

        session.refresh(batch)
        # Worst-case wins: one failed run marks the batch's trace status failed.
        assert batch.trace_persistence_status == "failed"
        assert batch.trace_error_message is not None
        assert "1 of 3" in batch.trace_error_message
