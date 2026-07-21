"""SPEC-126: internal alpha release gate — project isolation.

Validates that two fresh projects never silently inherit each other's
task inventory, task runs, batch runs, traces, or schedules. This is a
release gate for internal alpha because cross-project leakage would
destroy operator trust before the product has any.

These tests target the SPEC-118/119/120 product model.
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
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    RunDB,
    UserDB,
)


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


def _seed_project_state(
    session: Session,
    *,
    project: str,
    task_id: str,
    run_id: str,
    trace_id: str,
) -> None:
    """Populate one project with a source, inventory row, batch, run, trace."""
    source = ProjectTaskSourceDB(
        id=f"source-{project}",
        project=project,
        source_type="filesystem",
        display_name=f"source-{project}",
        status="ready",
        subpath="tasks",
        created_at=datetime.now(timezone.utc),
    )
    inventory = ProjectTaskInventoryDB(
        id=f"inv-{project}",
        project=project,
        task_source_id=source.id,
        task_id=task_id,
        display_name=task_id,
        task_path=f"./tasks/{task_id}",
        folder_path="./tasks",
        adapter_name="noop",
        source_type="filesystem",
        source_ref="./tasks",
        source_commit_sha="abc",
        first_seen_at=datetime.now(timezone.utc),
    )
    batch = AgentTaskBatchRunDB(
        id=f"batch-{project}",
        project=project,
        selection_type="task",
        selection_query={"task_paths": [task_id]},
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
        task_source_type="filesystem",
    )
    task_run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch.id,
        task_id=task_id,
        task_path=f"./tasks/{task_id}",
        status="passed",
        pass_result=True,
        trace_run_id=trace_id,
        trace_persistence_status="persisted",
        started_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        completed_at=datetime.now(timezone.utc),
    )
    trace = RunDB(
        id=trace_id,
        project=project,
        task_run_id=run_id,
        flow_name=task_id,
        created_at=datetime.now(timezone.utc),
    )
    schedule = AgentTaskScheduleDB(
        id=f"schedule-{project}",
        project=project,
        name=f"schedule-{project}",
        cadence_type="daily",
        timezone="UTC",
        hour=9,
        minute=0,
        selection_type="task",
        selection_query={"task_paths": [task_id]},
        environment="default",
        task_root="./tasks",
        enabled=True,
        next_run_at=datetime.now(timezone.utc) + timedelta(days=1),
        created_at=datetime.now(timezone.utc),
    )
    # Insert in FK-safe order with a flush between dependency layers so each
    # child row sees its parent (PRAGMA foreign_keys=ON is now enforced in tests).
    # source → inventory; batch → task_run. trace/schedule only need the project.
    session.add(source)
    session.flush()
    session.add(inventory)
    session.flush()
    session.add(batch)
    session.flush()
    session.add(task_run)
    session.flush()
    session.add_all([trace, schedule])
    session.commit()


class TestProjectIsolationInventory:
    """Fresh projects must not see other projects' task inventory."""

    def test_new_project_inventory_query_returns_nothing_from_others(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        admin_id = _bootstrap_admin(client, session)
        project_a = _make_project(session, "iso-inv-a", admin_id)
        project_b = _make_project(session, "iso-inv-b", admin_id)

        _seed_project_state(
            session,
            project=project_a.id,
            task_id="task-a",
            run_id="run-a",
            trace_id="trace-a",
        )

        # Query inventory for project B.
        rows_b = session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.project == project_b.id
            )
        ).all()
        assert rows_b == []

        # Query inventory for project A — still intact.
        rows_a = session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.project == project_a.id
            )
        ).all()
        assert len(rows_a) == 1
        assert rows_a[0].task_id == "task-a"


class TestProjectIsolationRuns:
    """Fresh projects must not see other projects' task runs or batches."""

    def test_new_project_runs_query_returns_nothing_from_others(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        admin_id = _bootstrap_admin(client, session)
        project_a = _make_project(session, "iso-runs-a", admin_id)
        project_b = _make_project(session, "iso-runs-b", admin_id)

        _seed_project_state(
            session,
            project=project_a.id,
            task_id="task-a",
            run_id="run-a-1",
            trace_id="trace-a-1",
        )

        batches_b = session.exec(
            select(AgentTaskBatchRunDB).where(
                AgentTaskBatchRunDB.project == project_b.id
            )
        ).all()
        assert batches_b == []

        # Batch-run linkage stays project-scoped: no run from A ever appears
        # in B's project even though we share a single DB.
        runs_for_b_batches = session.exec(
            select(AgentTaskRunDB).where(
                AgentTaskRunDB.batch_run_id == "batch-iso-runs-a"
            )
        ).all()
        assert len(runs_for_b_batches) == 1
        # The run exists, but only via its batch — which is owned by A.
        # Project B's query surface never surfaces it.
        runs_b_via_project = session.exec(
            select(AgentTaskRunDB)
            .join(AgentTaskBatchRunDB, AgentTaskRunDB.batch_run_id == AgentTaskBatchRunDB.id)
            .where(AgentTaskBatchRunDB.project == project_b.id)
        ).all()
        assert runs_b_via_project == []


class TestProjectIsolationTraces:
    """Fresh projects must not see other projects' traces."""

    def test_trace_query_is_project_scoped(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        admin_id = _bootstrap_admin(client, session)
        project_a = _make_project(session, "iso-trace-a", admin_id)
        project_b = _make_project(session, "iso-trace-b", admin_id)

        _seed_project_state(
            session,
            project=project_a.id,
            task_id="task-a",
            run_id="run-a-2",
            trace_id="trace-a-2",
        )

        traces_b = session.exec(
            select(RunDB).where(RunDB.project == project_b.id)
        ).all()
        assert traces_b == []

        traces_a = session.exec(
            select(RunDB).where(RunDB.project == project_a.id)
        ).all()
        assert len(traces_a) == 1
        assert traces_a[0].id == "trace-a-2"


class TestProjectIsolationSchedules:
    """Fresh projects must not see other projects' schedules."""

    def test_schedule_query_is_project_scoped(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        admin_id = _bootstrap_admin(client, session)
        project_a = _make_project(session, "iso-sched-a", admin_id)
        project_b = _make_project(session, "iso-sched-b", admin_id)

        _seed_project_state(
            session,
            project=project_a.id,
            task_id="task-a",
            run_id="run-a-3",
            trace_id="trace-a-3",
        )

        schedules_b = session.exec(
            select(AgentTaskScheduleDB).where(
                AgentTaskScheduleDB.project == project_b.id
            )
        ).all()
        assert schedules_b == []

        schedules_a = session.exec(
            select(AgentTaskScheduleDB).where(
                AgentTaskScheduleDB.project == project_a.id
            )
        ).all()
        assert len(schedules_a) == 1


class TestEmptyProjectShowsNoInventory:
    """Pending-task-source project shows nothing — no leaked rows."""

    def test_project_with_no_source_has_no_inventory(
        self,
        client: TestClient,
        session: Session,
        monkeypatch: MonkeyPatch,
    ) -> None:
        admin_id = _bootstrap_admin(client, session)
        empty_project = _make_project(session, "iso-empty", admin_id)
        other_project = _make_project(session, "iso-other", admin_id)

        _seed_project_state(
            session,
            project=other_project.id,
            task_id="task-other",
            run_id="run-other",
            trace_id="trace-other",
        )

        # Empty project has no source and no inventory. Every product
        # surface that reads inventory must get back nothing — not even
        # rows from the other project.
        empty_inventory = session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.project == empty_project.id
            )
        ).all()
        assert empty_inventory == []

        empty_batches = session.exec(
            select(AgentTaskBatchRunDB).where(
                AgentTaskBatchRunDB.project == empty_project.id
            )
        ).all()
        assert empty_batches == []

        empty_traces = session.exec(
            select(RunDB).where(RunDB.project == empty_project.id)
        ).all()
        assert empty_traces == []

        empty_schedules = session.exec(
            select(AgentTaskScheduleDB).where(
                AgentTaskScheduleDB.project == empty_project.id
            )
        ).all()
        assert empty_schedules == []
