"""SPEC-126: internal alpha release gate — scheduler restart recovery.

Validates that an unscheduled backend restart cannot leave the
scheduler in a state where:

 - in-flight work is silently forgotten about, or
 - the next dispatch double-fires the same schedule, or
 - schedules appear "due now" forever and confuse operators.

These tests target the alpha single-node topology and the in-process
scheduler specifically (see SPEC-124).
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
    recover_stuck_runs,
    update_batch_run_status,
)
from apo.services.agent_task_scheduler import (
    compute_next_run_at,
    run_due_schedules_once,
)


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


class TestRestartRecoversStuckBatches:
    """recover_stuck_runs() must mark orphaned in-flight work consistently."""

    def test_running_batch_marked_error_after_restart(
        self,
        client: TestClient,
        session: Session,
        monkeypatch: MonkeyPatch,
    ) -> None:
        _bind_to_test_engine(session, monkeypatch)

        admin_id = _bootstrap_admin(client, session)
        project = _make_project(session, "alpha-restart-1", admin_id)

        stuck_batch = AgentTaskBatchRunDB(
            id="batch-stuck-1",
            project=project.id,
            selection_type="all",
            task_root="./tasks",
            environment="default",
            run_metadata={"trigger": {"source": "api"}},
            status="running",
            total_tasks=1,
            started_at=datetime.now(timezone.utc),
            created_at=datetime.now(timezone.utc),
        )
        stuck_run = AgentTaskRunDB(
            id="run-stuck-1",
            batch_run_id="batch-stuck-1",
            task_id="task-1",
            task_path="./tasks/task-1",
            status="running",
            trace_persistence_status="pending",
        )
        session.add_all([stuck_batch, stuck_run])
        session.commit()

        recover_stuck_runs()

        session.refresh(stuck_batch)
        session.refresh(stuck_run)
        # Recovery recomputes the batch — it ends up "completed" with the
        # stuck run counted as errored, not silently forgotten.
        assert stuck_batch.status == "completed"
        assert stuck_batch.completed_at is not None
        assert stuck_batch.errored_tasks >= 1
        # Stuck run itself is marked error with a clear restart message.
        assert stuck_run.status == "error"
        assert stuck_run.pass_result is False
        assert stuck_run.error_message is not None
        assert "restarted" in stuck_run.error_message.lower()
        assert stuck_run.trace_persistence_status == "failed"

    def test_queued_batches_also_recovered(
        self,
        client: TestClient,
        session: Session,
        monkeypatch: MonkeyPatch,
    ) -> None:
        _bind_to_test_engine(session, monkeypatch)

        admin_id = _bootstrap_admin(client, session)
        project = _make_project(session, "alpha-restart-2", admin_id)

        queued = AgentTaskBatchRunDB(
            id="batch-queued-1",
            project=project.id,
            selection_type="all",
            task_root="./tasks",
            environment="default",
            run_metadata={"trigger": {"source": "api"}},
            status="queued",
            total_tasks=1,
            created_at=datetime.now(timezone.utc),
        )
        # Queued batches have no task runs yet — they need at least one
        # so update_batch_run_status has something to recompute against.
        pending_run = AgentTaskRunDB(
            id="run-queued-1",
            batch_run_id="batch-queued-1",
            task_id="task-1",
            task_path="./tasks/task-1",
            status="pending",
            trace_persistence_status="pending",
        )
        session.add_all([queued, pending_run])
        session.commit()

        recover_stuck_runs()

        session.refresh(queued)
        session.refresh(pending_run)
        # The batch ends up completed (with the now-errored run counted).
        assert queued.status in ("completed", "error")
        assert queued.completed_at is not None
        assert pending_run.status == "error"
        assert pending_run.error_message is not None
        assert "restarted" in pending_run.error_message.lower()

    def test_completed_batches_are_not_touched(
        self,
        client: TestClient,
        session: Session,
        monkeypatch: MonkeyPatch,
    ) -> None:
        _bind_to_test_engine(session, monkeypatch)

        admin_id = _bootstrap_admin(client, session)
        _ = _make_project(session, "alpha-restart-3", admin_id)

        completed = AgentTaskBatchRunDB(
            id="batch-completed-1",
            project="alpha-restart-3",
            selection_type="all",
            task_root="./tasks",
            environment="default",
            run_metadata={"trigger": {"source": "api"}},
            status="completed",
            total_tasks=1,
            passed_tasks=1,
            started_at=datetime.now(timezone.utc) - timedelta(minutes=5),
            completed_at=datetime.now(timezone.utc),
            created_at=datetime.now(timezone.utc) - timedelta(minutes=10),
            trace_persistence_status="persisted",
        )
        session.add(completed)
        session.commit()

        recover_stuck_runs()

        session.refresh(completed)
        assert completed.status == "completed"
        assert completed.passed_tasks == 1


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

        # Stub out batch creation — we only care that dispatch did NOT happen.
        created: list[object] = []

        def fake_create(*args, **kwargs):  # type: ignore[no-untyped-def]
            created.append((args, kwargs))
            raise AssertionError("schedule should not have dispatched")

        monkeypatch.setattr(
            "apo.services.agent_task_scheduler.create_batch_run",
            fake_create,
        )

        fired = run_due_schedules_once()
        assert fired == 0
        assert created == []

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


class TestScheduleNextRunAdvancesConsistently:
    """Schedules must advance their next_run_at after a successful dispatch."""

    def test_compute_next_run_at_returns_future_time(self) -> None:
        # Direct contract check on the helper that drives schedule advancement.
        now = datetime.now(timezone.utc)
        next_run = compute_next_run_at(
            cadence_type="daily",
            timezone_name="UTC",
            hour=9,
            minute=0,
            from_time=now + timedelta(minutes=1),
        )
        assert next_run > now


class TestUpdateBatchRunStatusRecoversTracePersistence:
    """SPEC-126: trace persistence failures must surface clearly post-restart."""

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
