"""Demo workspace seeding service.

Seeds a dedicated demo project with real task runs, batch runs, and traces
by running actual example-service tasks. The demo project is read-only
after seeding — users can browse but not mutate.

Inspired by Langfuse's seed-postgres.ts approach: fixed project ID,
deterministic seeding, no fake walkthrough mode.
"""

import os
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import delete
from sqlmodel import Session, col, select

from ..db import engine
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    LoggedCallDB,
    RunDB,
    RunMetricDB,
)
from .agent_task_runner import create_batch_run, start_batch_run_execution
from .agent_task_scheduler import compute_next_run_at

DEMO_PROJECT_ID = "demo"

DEMO_READ_ONLY_MESSAGE = "Demo workspace is read-only"
DEMO_READ_ONLY_STATUS = 403

DEMO_READ_ONLY_ENV = "DEMO_READ_ONLY"

# SPEC-122: separate flag for demo authoring. Demo authoring is a
# deployment-local concern and must not be granted by project role.
# When unset, we fall back to the legacy ``DEMO_READ_ONLY=false`` check
# so existing local workflows keep working.
DEMO_AUTHORING_ENABLED_ENV = "DEMO_AUTHORING_ENABLED"

# Resolved at import in services.paths (a leaf module) so inventory/sync can
# reach the demo root without importing this orchestration module.
from .paths import DEMO_TASK_ROOT  # noqa: E402


DEMO_SCHEDULE_IDS = [
    "demo-schedule-daily",
    "demo-schedule-weekly",
    "demo-schedule-monthly",
]


DEMO_TASKS = [
    "data-extraction",
    "document-qa",
    "api-testing",
    "config-generator",
]


def is_demo_read_only() -> bool:
    """Return whether mutations to the demo project are blocked.

    Reads from the DEMO_READ_ONLY environment variable. Defaults to True
    so production deployments remain read-only. Set DEMO_READ_ONLY=false
    locally to author demo content through the dashboard/API.
    """
    value = os.getenv(DEMO_READ_ONLY_ENV, "true").lower()
    return value not in ("false", "0", "off", "no")


def is_demo_authoring_enabled() -> bool:
    """Return whether demo authoring is allowed on this deployment.

    SPEC-122: demo authoring is decoupled from project role. It is
    controlled by the ``DEMO_AUTHORING_ENABLED`` env var. When unset,
    the legacy ``not is_demo_read_only()`` value is used so existing
    local workflows (``DEMO_READ_ONLY=false``) keep working.
    """
    raw = os.getenv(DEMO_AUTHORING_ENABLED_ENV, "").lower()
    if raw in ("true", "1", "on", "yes"):
        return True
    if raw in ("false", "0", "off", "no"):
        return False
    return not is_demo_read_only()


def require_project_not_demo(project: str | None) -> None:
    """Raise if a mutation targets the shared demo project and it is read-only."""
    if project == DEMO_PROJECT_ID and is_demo_read_only():
        raise HTTPException(
            status_code=DEMO_READ_ONLY_STATUS,
            detail=DEMO_READ_ONLY_MESSAGE,
        )


def require_run_not_demo(session: Session, run_id: str, project: str | None = None) -> RunDB:
    """Fetch a run and reject if it belongs to the demo project.

    When ``project`` is given, the lookup is scoped by ``(id, project)`` so two
    Projects sharing an OTel trace id cannot resolve to each other's run
    (SPEC-133 M4). Callers with an authenticated Project should always pass it.
    """
    statement = select(RunDB).where(RunDB.id == run_id)
    if project is not None:
        statement = statement.where(RunDB.project == project)
    run = session.exec(statement).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_project_not_demo(run.project)
    return run


def require_call_not_demo(
    session: Session, call_id: str, project: str | None = None
) -> LoggedCallDB:
    """Fetch a call and reject if its trace belongs to the demo project.

    When ``project`` is given, the lookup is scoped by ``(id, project)`` so two
    Projects sharing an OTel span id cannot resolve to each other's call
    (SPEC-133 M4). Callers with an authenticated Project should always pass it.
    """
    statement = select(LoggedCallDB).where(LoggedCallDB.id == call_id)
    if project is not None:
        statement = statement.where(LoggedCallDB.project == project)
    call = session.exec(statement).first()
    if not call or not call.run_id:
        raise HTTPException(status_code=404, detail="Call not found")
    run_statement = select(RunDB).where(RunDB.id == call.run_id)
    if project is not None:
        run_statement = run_statement.where(RunDB.project == project)
    run = session.exec(run_statement).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_project_not_demo(run.project)
    return call


def is_demo_seeded(session: Session) -> bool:
    """Check if the demo project already has batch runs."""
    statement = select(AgentTaskBatchRunDB).where(
        AgentTaskBatchRunDB.project == DEMO_PROJECT_ID
    )
    return session.exec(statement).first() is not None


def _clear_demo_workspace(session: Session) -> None:
    """Delete all demo project data so it can be re-seeded.

    Order matters because of foreign key relationships.
    """
    demo_batches = session.exec(
        select(AgentTaskBatchRunDB).where(
            AgentTaskBatchRunDB.project == DEMO_PROJECT_ID
        )
    ).all()
    batch_ids = {batch.id for batch in demo_batches}

    task_runs = session.exec(
        select(AgentTaskRunDB).where(
            col(AgentTaskRunDB.batch_run_id).in_(batch_ids)
        )
    ).all()
    for task_run in task_runs:
        session.delete(task_run)
    session.commit()

    for batch in demo_batches:
        session.delete(batch)
    session.commit()

    demo_runs = session.exec(
        select(RunDB).where(RunDB.project == DEMO_PROJECT_ID)
    ).all()
    run_ids = [run.id for run in demo_runs]

    if run_ids:
        _ = session.exec(
            delete(RunMetricDB).where(col(RunMetricDB.run_id).in_(run_ids))
        )
        _ = session.exec(
            delete(LoggedCallDB).where(col(LoggedCallDB.run_id).in_(run_ids))
        )
        session.commit()

    for run in demo_runs:
        session.delete(run)
    session.commit()

    for schedule_id in DEMO_SCHEDULE_IDS:
        existing = session.get(AgentTaskScheduleDB, schedule_id)
        if existing:
            session.delete(existing)
    session.commit()


def seed_demo_workspace(force: bool = False) -> str | None:
    """Seed the demo project with real task data.

    Creates a batch run with the demo tasks and starts execution.
    Returns the batch run ID, or None if already seeded (unless force=True).

    Args:
        force: If True, clear existing demo data before seeding.
    """
    # SPEC-122: demo authoring (seeding actual task runs) is a
    # deployment-local concern, gated by ``DEMO_AUTHORING_ENABLED``.
    # Project role does not grant demo authoring rights.
    if not is_demo_authoring_enabled():
        raise HTTPException(
            status_code=DEMO_READ_ONLY_STATUS,
            detail=(
                "Demo authoring is disabled on this deployment. Set "
                f"{DEMO_AUTHORING_ENABLED_ENV}=true to seed or re-seed demo content."
            ),
        )

    _ensure_demo_project_exists()
    with Session(engine) as session:
        if is_demo_seeded(session):
            if not force:
                return None
            _clear_demo_workspace(session)

        # Ensure the demo project advertises an explicit task source row
        # (SPEC-118) instead of relying on the legacy DEFAULT_TASK_ROOT
        # fallback. Safe to call repeatedly; no-op when already present.
        from .project_task_sources import ensure_demo_task_source

        ensure_demo_task_source(session)

        now = datetime.now(timezone.utc)

        batch = create_batch_run(
            session,
            project=DEMO_PROJECT_ID,
            selection_type="all",
            task_paths=None,
            task_root=DEMO_TASK_ROOT,
            grep=None,
            environment="demo",
            run_metadata={
                "trigger": {
                    "source": "demo-seed",
                    "actor": "system",
                    "entrypoint": "seed_demo_workspace",
                    "initiated_at": now.isoformat(),
                }
            },
        )

        schedules = [
            AgentTaskScheduleDB(
                id="demo-schedule-daily",
                project=DEMO_PROJECT_ID,
                name="Daily validation (all tasks)",
                selection_type="all",
                task_root=DEMO_TASK_ROOT,
                environment="demo",
                cadence_type="daily",
                timezone="UTC",
                hour=9,
                minute=0,
                # Disabled: the demo is read-only, so scheduled runs can't
                # persist their traces and would surface as failures. The
                # demo shows the pre-seeded runs as examples; it does not
                # generate new runs on a schedule.
                enabled=False,
                last_triggered_at=now,
                last_batch_run_id=batch.id,
                next_run_at=compute_next_run_at(
                    cadence_type="daily",
                    timezone_name="UTC",
                    hour=9,
                    minute=0,
                ),
                created_at=now,
                updated_at=now,
            ),
            AgentTaskScheduleDB(
                id="demo-schedule-weekly",
                project=DEMO_PROJECT_ID,
                name="Weekly regression (all tasks)",
                selection_type="all",
                task_root=DEMO_TASK_ROOT,
                environment="demo",
                cadence_type="weekly",
                timezone="UTC",
                hour=10,
                minute=0,
                day_of_week=1,
                enabled=False,
                last_triggered_at=now,
                next_run_at=compute_next_run_at(
                    cadence_type="weekly",
                    timezone_name="UTC",
                    hour=10,
                    minute=0,
                    day_of_week=1,
                ),
                created_at=now,
                updated_at=now,
            ),
            AgentTaskScheduleDB(
                id="demo-schedule-monthly",
                project=DEMO_PROJECT_ID,
                name="Monthly smoke test (all tasks)",
                selection_type="all",
                task_root=DEMO_TASK_ROOT,
                environment="demo",
                cadence_type="monthly",
                timezone="UTC",
                hour=8,
                minute=0,
                day_of_month=1,
                enabled=False,
                last_triggered_at=now,
                next_run_at=compute_next_run_at(
                    cadence_type="monthly",
                    timezone_name="UTC",
                    hour=8,
                    minute=0,
                    day_of_month=1,
                ),
                created_at=now,
                updated_at=now,
            ),
        ]

        for schedule in schedules:
            session.add(schedule)
        session.commit()

        start_batch_run_execution(batch.id)
        return batch.id


def ensure_demo_schedule(session: Session) -> None:
    """Ensure the demo schedules exist."""
    now = datetime.now(timezone.utc)
    yesterday = now.replace(hour=9, minute=0, second=0, microsecond=0)

    schedule_configs = [
        ("demo-schedule-daily", "Daily validation (all tasks)", "daily", 9, 0, None, None, False),
        ("demo-schedule-weekly", "Weekly regression (all tasks)", "weekly", 10, 0, 1, None, False),
        ("demo-schedule-monthly", "Monthly smoke test (all tasks)", "monthly", 8, 0, None, 1, False),
    ]

    for schedule_id, name, cadence, hour, minute, day_of_week, day_of_month, enabled in schedule_configs:
        existing = session.get(AgentTaskScheduleDB, schedule_id)
        if existing:
            # Keep existing schedules in sync with the read-only demo intent:
            # a previously-enabled demo schedule would keep firing runs whose
            # traces can't persist, generating perpetual failures.
            if existing.enabled:
                existing.enabled = False
                session.add(existing)
            continue
        schedule = AgentTaskScheduleDB(
            id=schedule_id,
            project=DEMO_PROJECT_ID,
            name=name,
            selection_type="all",
            task_root=DEMO_TASK_ROOT,
            environment="demo",
            cadence_type=cadence,
            timezone="UTC",
            hour=hour,
            minute=minute,
            day_of_week=day_of_week,
            day_of_month=day_of_month,
            enabled=enabled,
            last_triggered_at=yesterday,
            next_run_at=compute_next_run_at(
                cadence_type=cadence,
                timezone_name="UTC",
                hour=hour,
                minute=minute,
                day_of_week=day_of_week,
                day_of_month=day_of_month,
            ),
            created_at=now,
            updated_at=now,
        )
        session.add(schedule)
    session.commit()


def reset_demo_schedules(session: Session) -> None:
    """Delete and re-create demo schedules. Used to update schedule config."""
    for schedule_id in DEMO_SCHEDULE_IDS:
        existing = session.get(AgentTaskScheduleDB, schedule_id)
        if existing:
            session.delete(existing)
    session.commit()
    ensure_demo_schedule(session)


def _ensure_demo_project_exists() -> None:
    """Create the demo project row and task source if they don't exist.

    This runs at startup regardless of ``DEMO_AUTHORING_ENABLED`` so that:
    - The demo project shows up in project lists.
    - The demo task source is available (inventory shows tasks).
    - Users can browse demo data read-only.

    Only the *seeding* of actual task runs (``seed_demo_workspace``) is
    gated by the authoring flag.
    """
    from ..models.db import ProjectDB
    from .project_task_sources import ensure_demo_task_source

    with Session(engine) as session:
        existing = session.get(ProjectDB, DEMO_PROJECT_ID)
        if existing is None:
            now = datetime.now(timezone.utc)
            session.add(ProjectDB(
                id=DEMO_PROJECT_ID,
                name="Demo workspace",
                created_by=None,
                created_at=now,
                updated_at=now,
            ))
            session.commit()
        # Ensure the task source row exists so the demo project
        # advertises its source and inventory is populated.
        ensure_demo_task_source(session)
