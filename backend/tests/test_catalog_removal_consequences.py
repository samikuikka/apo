"""Consequences of a task leaving the project catalog.

Four behaviours are pinned here:

- A schedule whose selection resolves to nothing at trigger time (its task
  was removed from the catalog) must be paused with ``selection_empty``
  instead of raising — an escaping exception aborts the whole dispatch pass
  and starves every other due schedule. This holds for both cadence kinds
  (fixed and adaptive) and ONLY for an emptied selection: any other
  ValueError (e.g. an unknown timezone) is logged and retried, never
  mislabeled as ``selection_empty``.
- Adaptive (SM-2) state for removed tasks must be pruned when the catalog
  is replaced: ``next_run_at`` is the min over states, so one orphaned
  state keeps a schedule permanently "due" or stalls it past its real tasks.
- Catalog publication must *report* removals and affected schedules so the
  operator learns at publish time, not as a later trigger-time failure.
"""

from collections.abc import Iterator
from typing import cast
from datetime import datetime, timedelta, timezone
from pathlib import Path
from shutil import rmtree
from uuid import uuid4

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

from apo.models.db import (
    AdaptiveTaskStateDB,
    AgentTaskScheduleDB,
    ExecutorPoolDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
)
from apo.services.adaptive_scheduler import select_due_task_ids
from apo.services.agent_task_scheduler import run_due_schedules_once
from apo.services.project_task_source_sync import sync_task_source
from apo.services.task_catalog import publish_catalog, validate_catalog_request


def _inventory_task_ids(session: Session, project: str) -> tuple[str, str]:
    """Return the project's two inventory task_ids, sorted."""
    rows = session.exec(
        select(ProjectTaskInventoryDB).where(
            ProjectTaskInventoryDB.project == project
        )
    ).all()
    ids = sorted(row.task_id for row in rows)
    assert len(ids) == 2, f"expected two tasks, got {ids}"
    return ids[0], ids[1]


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


def _write_task(root: Path, folder: str, name: str) -> Path:
    task_dir = root / folder / name
    task_dir.mkdir(parents=True)
    _ = (task_dir / f"{name}.eval.ts").write_text(
        f'import {{ task }} from "@apo-ai/sdk/agent-task";\ntask("{name}", {{ adapter: "a" }});\n'
    )
    return task_dir


def _bootstrap_project(
    session: Session,
    *,
    tmp_path: Path,
    now: datetime,
) -> tuple[str, str, ProjectTaskSourceDB]:
    """Project + default pool + ready filesystem source over ``tmp_path``."""
    project = f"removal-{uuid4().hex[:8]}"
    pool_id = f"pool-{uuid4().hex[:8]}"
    session.add(ProjectDB(id=project, name=project, created_at=now))
    session.flush()
    session.add(
        ExecutorPoolDB(
            id=pool_id,
            project=project,
            name="Bundled",
            slug="bundled",
            kind="bundled",
            enabled=True,
            created_at=now,
            updated_at=now,
        )
    )
    session.flush()
    project_row = session.get(ProjectDB, project)
    assert project_row is not None
    project_row.default_executor_pool_id = pool_id
    session.add(project_row)
    source = ProjectTaskSourceDB(
        id=f"source-{project}",
        project=project,
        source_type="filesystem",
        display_name="Removal tests",
        filesystem_path=str(tmp_path),
        status="ready",
        last_synced_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(source)
    session.commit()
    return project, pool_id, source


def _make_daily_schedule(
    session: Session,
    *,
    schedule_id: str,
    project: str,
    pool_id: str | None,
    selection_query: dict[str, object],
    now: datetime,
    timezone_name: str = "UTC",
) -> AgentTaskScheduleDB:
    schedule = AgentTaskScheduleDB(
        id=schedule_id,
        project=project,
        name=schedule_id,
        selection_type="tasks",
        selection_query=selection_query,
        environment="default",
        cadence_type="daily",
        timezone=timezone_name,
        hour=9,
        minute=0,
        enabled=True,
        executor_pool_id=pool_id,
        next_run_at=now - timedelta(minutes=5),
        created_at=now,
        updated_at=now,
    )
    session.add(schedule)
    session.commit()
    return schedule


def _adaptive_state(
    session: Session,
    *,
    schedule_id: str,
    task_id: str,
    next_run_at: datetime,
) -> AdaptiveTaskStateDB:
    state = AdaptiveTaskStateDB(
        id=f"{schedule_id}||{task_id}",
        schedule_id=schedule_id,
        task_id=task_id,
        task_path=task_id,
        current_interval_days=1.0,
        ease_factor=2.5,
        consecutive_passes=1,
        next_run_at=next_run_at,
    )
    session.add(state)
    session.commit()
    return state


def _states_for(session: Session, schedule_id: str) -> set[str]:
    return {
        state.task_id
        for state in session.exec(
            select(AdaptiveTaskStateDB).where(
                AdaptiveTaskStateDB.schedule_id == schedule_id
            )
        ).all()
    }


class TestBrokenScheduleDoesNotStarveOthers:
    def test_removed_task_pauses_schedule_and_others_still_dispatch(
        self, tmp_path: Path, monkeypatch: MonkeyPatch, schedule_engine: Engine
    ) -> None:
        now = datetime.now(timezone.utc)
        _ = _write_task(tmp_path, "flows", "alpha")
        beta_dir = _write_task(tmp_path, "flows", "beta")

        monkeypatch.setattr(
            "apo.services.agent_task_scheduler.engine", schedule_engine
        )
        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "artifacts"))

        with Session(schedule_engine) as session:
            project, pool_id, source = _bootstrap_project(
                session, tmp_path=tmp_path, now=now
            )
            _ = sync_task_source(session, source)
            beta_task_path = str(beta_dir)
            # Broken schedule first in insertion order, to prove order
            # cannot let it shadow the healthy one.
            _ = _make_daily_schedule(
                session,
                schedule_id="sched-broken",
                project=project,
                pool_id=pool_id,
                selection_query={"task_paths": [beta_task_path]},
                now=now,
            )
            _ = _make_daily_schedule(
                session,
                schedule_id="sched-healthy",
                project=project,
                pool_id=pool_id,
                selection_query={"task_paths": [str(tmp_path / "flows" / "alpha")]},
                now=now,
            )

            # beta leaves the catalog.
            rmtree(tmp_path / "flows" / "beta")
            _ = sync_task_source(session, source)

        created = run_due_schedules_once()
        assert created == 1

        with Session(schedule_engine) as session:
            broken = session.get(AgentTaskScheduleDB, "sched-broken")
            assert broken is not None
            assert broken.enabled is False
            assert broken.disabled_reason == "selection_empty"
            assert broken.next_run_at is None
            assert broken.last_batch_run_id is None

            healthy = session.get(AgentTaskScheduleDB, "sched-healthy")
            assert healthy is not None
            assert healthy.enabled is True
            assert healthy.last_batch_run_id is not None
            next_run_at = healthy.next_run_at
            assert next_run_at is not None
            if next_run_at.tzinfo is None:
                next_run_at = next_run_at.replace(tzinfo=timezone.utc)
            assert next_run_at > now

    def test_schedule_using_project_default_pool_dispatches(
        self, tmp_path: Path, monkeypatch: MonkeyPatch, schedule_engine: Engine
    ) -> None:
        now = datetime.now(timezone.utc)
        _ = _write_task(tmp_path, "flows", "alpha")

        monkeypatch.setattr(
            "apo.services.agent_task_scheduler.engine", schedule_engine
        )
        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "artifacts"))

        with Session(schedule_engine) as session:
            project, _pool_id, source = _bootstrap_project(
                session, tmp_path=tmp_path, now=now
            )
            _ = sync_task_source(session, source)
            # executor_pool_id None: the dispatcher must pass through the
            # project's default pool instead of raising executor_pool_required.
            _ = _make_daily_schedule(
                session,
                schedule_id="sched-default-pool",
                project=project,
                pool_id=None,
                selection_query={"task_paths": [str(tmp_path / "flows" / "alpha")]},
                now=now,
            )

        assert run_due_schedules_once() == 1

        with Session(schedule_engine) as session:
            schedule = session.get(AgentTaskScheduleDB, "sched-default-pool")
            assert schedule is not None
            assert schedule.last_batch_run_id is not None

    def test_adaptive_schedule_with_emptied_selection_pauses(
        self, tmp_path: Path, monkeypatch: MonkeyPatch, schedule_engine: Engine
    ) -> None:
        """An emptied selection pauses an adaptive schedule too.

        The fixed-cadence path pauses via the no-tasks error from batch
        creation; without the empty check in ``select_due_task_ids`` the
        adaptive path would instead re-arm at ``min_interval_days`` forever,
        silently, contradicting the documented ``selection_empty`` pause.
        """
        now = datetime.now(timezone.utc)
        beta_dir = _write_task(tmp_path, "flows", "beta")

        monkeypatch.setattr(
            "apo.services.agent_task_scheduler.engine", schedule_engine
        )
        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "artifacts"))

        with Session(schedule_engine) as session:
            project, pool_id, source = _bootstrap_project(
                session, tmp_path=tmp_path, now=now
            )
            _ = sync_task_source(session, source)
            session.add(
                AgentTaskScheduleDB(
                    id="sched-adaptive-empty",
                    project=project,
                    name="adaptive-empty",
                    selection_type="tasks",
                    selection_query={"task_paths": [str(beta_dir)]},
                    environment="default",
                    cadence_type="adaptive",
                    timezone="UTC",
                    hour=9,
                    minute=0,
                    min_interval_days=1.0,
                    max_interval_days=30.0,
                    enabled=True,
                    executor_pool_id=pool_id,
                    next_run_at=now - timedelta(minutes=5),
                    created_at=now,
                    updated_at=now,
                )
            )
            session.commit()

            # beta leaves the catalog.
            rmtree(beta_dir)
            _ = sync_task_source(session, source)

        assert run_due_schedules_once() == 0

        with Session(schedule_engine) as session:
            schedule = session.get(AgentTaskScheduleDB, "sched-adaptive-empty")
            assert schedule is not None
            assert schedule.enabled is False
            assert schedule.disabled_reason == "selection_empty"
            assert schedule.next_run_at is None
            assert schedule.last_batch_run_id is None

    def test_unknown_timezone_is_not_reported_as_selection_empty(
        self, tmp_path: Path, monkeypatch: MonkeyPatch, schedule_engine: Engine
    ) -> None:
        """A non-selection ValueError must not pause as ``selection_empty``.

        Pausing on it would both mislabel the schedule (the operator
        re-points a selection that is fine) and make transient errors
        (stale-inventory race) permanent. The schedule stays due and the
        error is logged for the next poll to retry.
        """
        now = datetime.now(timezone.utc)
        _ = _write_task(tmp_path, "flows", "alpha")

        monkeypatch.setattr(
            "apo.services.agent_task_scheduler.engine", schedule_engine
        )
        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "artifacts"))

        with Session(schedule_engine) as session:
            project, pool_id, source = _bootstrap_project(
                session, tmp_path=tmp_path, now=now
            )
            _ = sync_task_source(session, source)
            _ = _make_daily_schedule(
                session,
                schedule_id="sched-bad-tz",
                project=project,
                pool_id=pool_id,
                selection_query={"task_paths": [str(tmp_path / "flows" / "alpha")]},
                now=now,
                timezone_name="Not/AZone",
            )

        assert run_due_schedules_once() == 0

        with Session(schedule_engine) as session:
            schedule = session.get(AgentTaskScheduleDB, "sched-bad-tz")
            assert schedule is not None
            assert schedule.enabled is True
            assert schedule.disabled_reason is None
            assert schedule.last_batch_run_id is None


class TestOrphanedAdaptiveState:
    def test_replace_inventory_prunes_states_for_removed_tasks(
        self, tmp_path: Path, schedule_engine: Engine
    ) -> None:
        now = datetime.now(timezone.utc)
        _ = _write_task(tmp_path, "flows", "alpha")
        _ = _write_task(tmp_path, "flows", "beta")

        with Session(schedule_engine) as session:
            project, _pool_id, source = _bootstrap_project(
                session, tmp_path=tmp_path, now=now
            )
            _ = sync_task_source(session, source)
            alpha_id, beta_id = _inventory_task_ids(session, project)

            schedule = AgentTaskScheduleDB(
                id="sched-adaptive",
                project=project,
                name="Adaptive",
                selection_type="all",
                environment="default",
                cadence_type="adaptive",
                timezone="UTC",
                hour=9,
                minute=0,
                min_interval_days=1.0,
                max_interval_days=30.0,
                enabled=True,
                executor_pool_id=None,
                next_run_at=now - timedelta(minutes=5),
                created_at=now,
                updated_at=now,
            )
            session.add(schedule)
            session.flush()
            _ = _adaptive_state(
                session,
                schedule_id="sched-adaptive",
                task_id=alpha_id,
                next_run_at=now + timedelta(days=3),
            )
            _ = _adaptive_state(
                session,
                schedule_id="sched-adaptive",
                task_id=beta_id,
                next_run_at=now - timedelta(days=1),
            )

            # beta leaves the catalog on the next sync.
            rmtree(tmp_path / "flows" / "beta")
            _ = sync_task_source(session, source)

            assert _states_for(session, "sched-adaptive") == {alpha_id}
            schedule = session.get(AgentTaskScheduleDB, "sched-adaptive")
            assert schedule is not None
            next_run_at = schedule.next_run_at
            assert next_run_at is not None
            if next_run_at.tzinfo is None:
                next_run_at = next_run_at.replace(tzinfo=timezone.utc)
            # The surviving task's state (not the orphan's past time) drives
            # the schedule now.
            assert next_run_at > now

    def test_due_poll_prunes_orphan_and_unsticks_schedule(
        self, tmp_path: Path, monkeypatch: MonkeyPatch, schedule_engine: Engine
    ) -> None:
        now = datetime.now(timezone.utc)
        _ = _write_task(tmp_path, "flows", "alpha")
        _ = _write_task(tmp_path, "flows", "beta")

        monkeypatch.setattr(
            "apo.services.agent_task_scheduler.engine", schedule_engine
        )

        with Session(schedule_engine) as session:
            project, _pool_id, source = _bootstrap_project(
                session, tmp_path=tmp_path, now=now
            )
            _ = sync_task_source(session, source)
            alpha_id, beta_id = _inventory_task_ids(session, project)

            schedule = AgentTaskScheduleDB(
                id="sched-adaptive",
                project=project,
                name="Adaptive",
                selection_type="all",
                environment="default",
                cadence_type="adaptive",
                timezone="UTC",
                hour=9,
                minute=0,
                min_interval_days=1.0,
                max_interval_days=30.0,
                enabled=True,
                executor_pool_id=None,
                # Orphaned beta state (past) pins the schedule "due".
                next_run_at=now - timedelta(days=1),
                created_at=now,
                updated_at=now,
            )
            session.add(schedule)
            session.flush()
            _ = _adaptive_state(
                session,
                schedule_id="sched-adaptive",
                task_id=alpha_id,
                next_run_at=now + timedelta(days=3),
            )
            _ = _adaptive_state(
                session,
                schedule_id="sched-adaptive",
                task_id=beta_id,
                next_run_at=now - timedelta(days=1),
            )

            # beta leaves the catalog — the sync's chokepoint prune removes
            # its state. Re-inject the stale state and re-pin the schedule
            # "due", simulating a pre-fix database: the next due poll must
            # prune the orphan lazily.
            rmtree(tmp_path / "flows" / "beta")
            _ = sync_task_source(session, source)
            # Re-add the stale state the sync's chokepoint prune just removed
            # and re-pin the schedule "due", simulating a pre-fix database.
            _ = _adaptive_state(
                session,
                schedule_id="sched-adaptive",
                task_id=beta_id,
                next_run_at=now - timedelta(days=1),
            )
            schedule_row = session.get(AgentTaskScheduleDB, "sched-adaptive")
            assert schedule_row is not None
            schedule_row.next_run_at = now - timedelta(days=1)
            session.add(schedule_row)
            session.commit()

        created = run_due_schedules_once()
        assert created == 0

        with Session(schedule_engine) as session:
            assert _states_for(session, "sched-adaptive") == {alpha_id}
            schedule = session.get(AgentTaskScheduleDB, "sched-adaptive")
            assert schedule is not None
            next_run_at = schedule.next_run_at
            assert next_run_at is not None
            if next_run_at.tzinfo is None:
                next_run_at = next_run_at.replace(tzinfo=timezone.utc)
            assert next_run_at > now

    def test_selection_edit_prunes_dropped_task_state(
        self, tmp_path: Path, schedule_engine: Engine
    ) -> None:
        now = datetime.now(timezone.utc)
        _ = _write_task(tmp_path, "flows", "alpha")
        _ = _write_task(tmp_path, "flows", "beta")

        with Session(schedule_engine) as session:
            project, _pool_id, source = _bootstrap_project(
                session, tmp_path=tmp_path, now=now
            )
            _ = sync_task_source(session, source)
            alpha_id, beta_id = _inventory_task_ids(session, project)

            schedule = AgentTaskScheduleDB(
                id="sched-edited",
                project=project,
                name="Edited",
                selection_type="tasks",
                selection_query={"task_paths": [alpha_id, beta_id]},
                environment="default",
                cadence_type="adaptive",
                timezone="UTC",
                hour=9,
                minute=0,
                enabled=True,
                executor_pool_id=None,
                next_run_at=now - timedelta(minutes=5),
                created_at=now,
                updated_at=now,
            )
            session.add(schedule)
            session.flush()
            _ = _adaptive_state(
                session,
                schedule_id="sched-edited",
                task_id=alpha_id,
                next_run_at=now + timedelta(days=3),
            )
            _ = _adaptive_state(
                session,
                schedule_id="sched-edited",
                task_id=beta_id,
                next_run_at=now - timedelta(days=1),
            )

            # Selection edited down to alpha only.
            schedule.selection_query = {"task_paths": [alpha_id]}
            session.add(schedule)
            session.commit()

            due = select_due_task_ids(session, schedule, source, now)

            assert due == []
            assert _states_for(session, "sched-edited") == {alpha_id}


class TestPublishCatalogRemovalWarnings:
    def test_publish_reports_removed_tasks_and_prunes_states(
        self, schedule_engine: Engine
    ) -> None:
        now = datetime.now(timezone.utc)
        with Session(schedule_engine) as session:
            project = f"pub-{uuid4().hex[:8]}"
            session.add(ProjectDB(id=project, name=project, created_at=now))
            session.commit()

            v1 = validate_catalog_request(
                [
                    {
                        "task_id": "task-a",
                        "display_name": "task-a",
                        "adapter_name": "cli",
                        "task_path": "task-a/task-a.eval.ts",
                        "folder_path": "",
                        "has_checks": True,
                        "tags": [],
                    },
                    {
                        "task_id": "task-b",
                        "display_name": "task-b",
                        "adapter_name": "cli",
                        "task_path": "task-b/task-b.eval.ts",
                        "folder_path": "",
                        "has_checks": False,
                        "tags": [],
                    },
                ]
            )
            first = publish_catalog(session, project, v1)
            assert "removed_tasks" not in first

            adaptive = AgentTaskScheduleDB(
                id="sched-pub-adaptive",
                project=project,
                name="Pub adaptive",
                selection_type="all",
                environment="default",
                cadence_type="adaptive",
                timezone="UTC",
                hour=9,
                minute=0,
                enabled=True,
                executor_pool_id=None,
                next_run_at=now + timedelta(days=1),
                created_at=now,
                updated_at=now,
            )
            legacy = AgentTaskScheduleDB(
                id="sched-pub-legacy",
                project=project,
                name="Pub legacy",
                selection_type="tasks",
                selection_query={"task_paths": ["task-b"]},
                environment="default",
                cadence_type="daily",
                timezone="UTC",
                hour=9,
                minute=0,
                enabled=True,
                executor_pool_id=None,
                next_run_at=now + timedelta(days=1),
                created_at=now,
                updated_at=now,
            )
            session.add(adaptive)
            session.add(legacy)
            session.flush()
            _ = _adaptive_state(
                session,
                schedule_id="sched-pub-adaptive",
                task_id="task-a",
                next_run_at=now + timedelta(days=2),
            )
            _ = _adaptive_state(
                session,
                schedule_id="sched-pub-adaptive",
                task_id="task-b",
                next_run_at=now - timedelta(days=1),
            )

            v2 = [task for task in v1 if task["task_id"] == "task-a"]
            second = publish_catalog(session, project, v2)

            assert second["removed_tasks"] == ["task-b"]
            raw_affected = cast(
                list[dict[str, object]], second["affected_schedules"]
            )
            affected = {str(entry["id"]): entry for entry in raw_affected}
            assert affected["sched-pub-adaptive"]["pruned_states"] == 1
            assert affected["sched-pub-legacy"]["selection_references"] == [
                "task-b"
            ]
            assert _states_for(session, "sched-pub-adaptive") == {"task-a"}
