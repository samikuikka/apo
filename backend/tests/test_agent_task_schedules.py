import os
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

from apo.models.db import (
    AdaptiveTaskStateDB,
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
)
from apo.services.agent_task_scheduler import (
    compute_next_run_at,
    run_due_schedules_once,
    validate_schedule_fields,
)
from apo.services.adaptive_scheduler import (
    compute_adaptive_next_run,
    compute_adaptive_next_run_at,
)


@pytest.fixture
def schedule_engine() -> Iterator[Engine]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    try:
        yield engine
    finally:
        SQLModel.metadata.drop_all(engine)
        engine.dispose()


def test_compute_next_run_at_daily_is_in_future():
    now = datetime(2026, 6, 4, 8, 15, tzinfo=timezone.utc)
    next_run = compute_next_run_at(
        cadence_type="daily",
        timezone_name="UTC",
        hour=9,
        minute=0,
        from_time=now,
    )

    assert next_run > now
    assert next_run.hour == 9
    assert next_run.minute == 0


def test_run_due_schedules_once_creates_batch_run(
    tmp_path: Path, monkeypatch: MonkeyPatch, schedule_engine: Engine
):
    task_dir = tmp_path / "flows" / "nightly-security"
    task_dir.mkdir(parents=True)
    _ = (task_dir / "nightly-security.eval.ts").write_text(
        'import { task } from "@apo/sdk/agent-task";\ntask("nightly-security", { adapter: "a" });\n'
    )

    schedule_id = uuid4().hex[:16]
    project = f"schedule-test-{uuid4().hex[:8]}"
    now = datetime.now(timezone.utc)
    started_batch_ids: list[str] = []

    def _capture_started_batch(batch_id: str) -> None:
        started_batch_ids.append(batch_id)

    monkeypatch.setattr(
        "apo.services.agent_task_scheduler.start_batch_run_execution",
        _capture_started_batch,
    )
    monkeypatch.setattr(
        "apo.services.agent_task_scheduler.engine",
        schedule_engine,
    )

    with Session(schedule_engine) as session:
        schedule = AgentTaskScheduleDB(
            id=schedule_id,
            project=project,
            name="Nightly Security",
            selection_type="task",
            selection_query={"task_paths": [str(task_dir)]},
            task_root=str(tmp_path),
            environment="default",
            cadence_type="daily",
            timezone="UTC",
            hour=9,
            minute=0,
            enabled=True,
            next_run_at=now - timedelta(minutes=5),
            created_at=now,
            updated_at=now,
        )
        session.add(schedule)
        session.commit()

    try:
        created = run_due_schedules_once()
        assert created == 1

        with Session(schedule_engine) as session:
            refreshed_schedule = session.get(AgentTaskScheduleDB, schedule_id)
            assert refreshed_schedule is not None
            assert refreshed_schedule.last_batch_run_id is not None
            assert refreshed_schedule.last_triggered_at is not None
            assert refreshed_schedule.next_run_at is not None
            assert refreshed_schedule.next_run_at.timestamp() > now.timestamp()

            batch = session.get(
                AgentTaskBatchRunDB, refreshed_schedule.last_batch_run_id
            )
            assert batch is not None
            assert batch.project == project
            assert batch.selection_type == "task"

            task_runs = session.exec(
                select(AgentTaskRunDB).where(
                    AgentTaskRunDB.batch_run_id == refreshed_schedule.last_batch_run_id
                )
            ).all()
            assert len(task_runs) == 1
            # Discovery ids are folder-scoped (folder/name) so tasks that
            # share a name remain selectable independently. This task lives
            # under the "flows" folder relative to the task root.
            assert task_runs[0].task_id == os.path.join("flows", "nightly-security")
            assert task_runs[0].status == "pending"

        assert started_batch_ids == [refreshed_schedule.last_batch_run_id]
    finally:
        with Session(schedule_engine) as session:
            schedule = session.get(AgentTaskScheduleDB, schedule_id)
            if schedule is not None:
                if schedule.last_batch_run_id:
                    task_runs = session.exec(
                        select(AgentTaskRunDB).where(
                            AgentTaskRunDB.batch_run_id == schedule.last_batch_run_id
                        )
                    ).all()
                    for task_run in task_runs:
                        session.delete(task_run)
                    batch = session.get(AgentTaskBatchRunDB, schedule.last_batch_run_id)
                    if batch is not None:
                        session.delete(batch)
                session.delete(schedule)
                session.commit()


# ============================================================================
# SPEC-069: Adaptive (SM-2) scheduling tests
# ============================================================================


def test_adaptive_pass_increases_interval():
    """A passing task multiplies its interval by the ease factor."""
    new_interval, new_ease, new_consecutive = compute_adaptive_next_run(
        current_interval_days=1.0,
        ease_factor=2.5,
        consecutive_passes=0,
        passed=True,
        min_interval_days=1.0,
        max_interval_days=30.0,
    )
    assert new_interval == 2.5
    assert new_ease == 2.55
    assert new_consecutive == 1


def test_adaptive_fail_resets_to_min():
    """A failing task resets to the minimum interval and drops ease."""
    new_interval, new_ease, new_consecutive = compute_adaptive_next_run(
        current_interval_days=7.5,
        ease_factor=2.5,
        consecutive_passes=5,
        passed=False,
        min_interval_days=1.0,
        max_interval_days=30.0,
    )
    assert new_interval == 1.0
    assert new_ease == 2.3
    assert new_consecutive == 0


def test_adaptive_interval_capped_at_max():
    """Passing a task near the max interval clamps to max."""
    new_interval, _, _ = compute_adaptive_next_run(
        current_interval_days=25.0,
        ease_factor=2.5,
        consecutive_passes=10,
        passed=True,
        min_interval_days=1.0,
        max_interval_days=30.0,
    )
    assert new_interval == 30.0


def test_adaptive_ease_never_drops_below_floor():
    """Ease factor is floored at 1.3 even after many failures."""
    _, new_ease, _ = compute_adaptive_next_run(
        current_interval_days=1.0,
        ease_factor=1.35,
        consecutive_passes=0,
        passed=False,
        min_interval_days=1.0,
        max_interval_days=30.0,
    )
    assert new_ease == 1.3


def test_adaptive_next_run_at_is_in_future():
    """The computed next_run_at is interval_days ahead, snapped to base_hour."""
    now = datetime(2026, 6, 4, 8, 15, tzinfo=timezone.utc)
    next_run = compute_adaptive_next_run_at(
        interval_days=2.5,
        base_hour=9,
        base_timezone="UTC",
        from_time=now,
    )
    assert next_run > now
    assert next_run.hour == 9
    assert next_run.minute == 0


def test_validate_adaptive_rejects_min_greater_than_max():
    """Validation rejects min_interval_days > max_interval_days."""
    import pytest

    with pytest.raises(ValueError, match="min_interval_days must be <= max_interval_days"):
        validate_schedule_fields(
            selection_type="tasks",
            cadence_type="adaptive",
            timezone_name="UTC",
            hour=9,
            minute=0,
            day_of_week=None,
            day_of_month=None,
            min_interval_days=10.0,
            max_interval_days=5.0,
        )


def test_validate_adaptive_accepts_valid_bounds():
    """Validation passes for adaptive with valid min/max."""
    validate_schedule_fields(
        selection_type="tasks",
        cadence_type="adaptive",
        timezone_name="UTC",
        hour=9,
        minute=0,
        day_of_week=None,
        day_of_month=None,
        min_interval_days=1.0,
        max_interval_days=30.0,
    )


def test_compute_next_run_at_adaptive_uses_min_interval():
    """Initial adaptive next_run_at is min_interval_days ahead at base_hour."""
    now = datetime(2026, 6, 4, 8, 15, tzinfo=timezone.utc)
    next_run = compute_next_run_at(
        cadence_type="adaptive",
        timezone_name="UTC",
        hour=9,
        minute=0,
        from_time=now,
        min_interval_days=1.0,
    )
    assert next_run > now
    assert next_run.hour == 9
    assert next_run.minute == 0


def test_update_adaptive_state_after_batch_pass(
    tmp_path: Path, schedule_engine: Engine
):
    """A passing batch run creates state and increases the interval."""
    from apo.services.adaptive_scheduler import (
        update_adaptive_state_after_batch,
    )

    schedule_id = uuid4().hex[:16]
    project = f"adaptive-test-{uuid4().hex[:8]}"
    now = datetime.now(timezone.utc)

    with Session(schedule_engine) as session:
        schedule = AgentTaskScheduleDB(
            id=schedule_id,
            project=project,
            name="Adaptive Test",
            selection_type="tasks",
            selection_query={"task_paths": ["task-a"]},
            task_root=str(tmp_path),
            environment="default",
            cadence_type="adaptive",
            timezone="UTC",
            hour=9,
            minute=0,
            min_interval_days=1.0,
            max_interval_days=30.0,
            enabled=True,
            next_run_at=now - timedelta(minutes=5),
            created_at=now,
            updated_at=now,
        )
        session.add(schedule)

        batch = AgentTaskBatchRunDB(
            id=uuid4().hex[:16],
            project=project,
            selection_type="tasks",
            status="completed",
            total_tasks=1,
            passed_tasks=1,
            created_at=now,
            completed_at=now,
        )
        session.add(batch)

        task_run = AgentTaskRunDB(
            id=uuid4().hex[:16],
            batch_run_id=batch.id,
            task_id="task-a",
            task_path=str(tmp_path / "task-a"),
            status="passed",
            pass_result=True,
        )
        session.add(task_run)
        session.commit()

        try:
            update_adaptive_state_after_batch(session, schedule, batch)

            refreshed = session.get(AgentTaskScheduleDB, schedule_id)
            assert refreshed is not None
            assert refreshed.next_run_at is not None
            assert refreshed.next_run_at.timestamp() > now.timestamp()

            state = session.exec(
                select(AdaptiveTaskStateDB).where(
                    AdaptiveTaskStateDB.schedule_id == schedule_id
                )
            ).one()
            assert state.task_id == "task-a"
            assert state.current_interval_days == 2.5
            assert state.ease_factor == 2.55
            assert state.consecutive_passes == 1
            assert state.last_status == "passed"
        finally:
            _cleanup_adaptive_test(session, schedule_id, batch.id)


def test_update_adaptive_state_after_batch_fail(
    tmp_path: Path, schedule_engine: Engine
):
    """A failing batch run resets the task to the minimum interval."""
    from apo.services.adaptive_scheduler import (
        update_adaptive_state_after_batch,
    )

    schedule_id = uuid4().hex[:16]
    project = f"adaptive-fail-{uuid4().hex[:8]}"
    now = datetime.now(timezone.utc)

    with Session(schedule_engine) as session:
        schedule = AgentTaskScheduleDB(
            id=schedule_id,
            project=project,
            name="Adaptive Fail Test",
            selection_type="tasks",
            selection_query={"task_paths": ["task-b"]},
            task_root=str(tmp_path),
            environment="default",
            cadence_type="adaptive",
            timezone="UTC",
            hour=9,
            minute=0,
            min_interval_days=1.0,
            max_interval_days=30.0,
            enabled=True,
            next_run_at=now - timedelta(minutes=5),
            created_at=now,
            updated_at=now,
        )
        session.add(schedule)

        batch = AgentTaskBatchRunDB(
            id=uuid4().hex[:16],
            project=project,
            selection_type="tasks",
            status="completed",
            total_tasks=1,
            failed_tasks=1,
            created_at=now,
            completed_at=now,
        )
        session.add(batch)

        task_run = AgentTaskRunDB(
            id=uuid4().hex[:16],
            batch_run_id=batch.id,
            task_id="task-b",
            task_path=str(tmp_path / "task-b"),
            status="failed",
            pass_result=False,
        )
        session.add(task_run)
        session.commit()

        try:
            update_adaptive_state_after_batch(session, schedule, batch)

            state = session.exec(
                select(AdaptiveTaskStateDB).where(
                    AdaptiveTaskStateDB.schedule_id == schedule_id
                )
            ).one()
            assert state.current_interval_days == 1.0
            assert state.ease_factor == 2.3
            assert state.consecutive_passes == 0
            assert state.last_status == "failed"
        finally:
            _cleanup_adaptive_test(session, schedule_id, batch.id)


def _cleanup_adaptive_test(session: Session, schedule_id: str, batch_id: str) -> None:
    """Remove test artefacts so tests don't pollute each other."""
    states = session.exec(
        select(AdaptiveTaskStateDB).where(
            AdaptiveTaskStateDB.schedule_id == schedule_id
        )
    ).all()
    for s in states:
        session.delete(s)
    task_runs = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch_id)
    ).all()
    for tr in task_runs:
        session.delete(tr)
    session.flush()
    batch = session.get(AgentTaskBatchRunDB, batch_id)
    if batch is not None:
        session.delete(batch)
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is not None:
        session.delete(schedule)
    session.commit()
