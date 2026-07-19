"""
Agent task schedule API endpoints.
"""

# pyright: reportCallInDefaultInitializer=false

from datetime import datetime, timezone
from typing import cast
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import desc
from sqlmodel import Session, select

from ..db import get_session
from ..db_helpers import _as_column
from ..models import (
    AdaptiveTaskStateSummary,
    AgentTaskBatchRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleDetail,
    AgentTaskScheduleSummary,
    CreateAgentTaskScheduleRequest,
    ScheduleLastBatchSummary,
    UpdateAgentTaskScheduleRequest,
)
from ..models.db import AdaptiveTaskStateDB, AgentTaskRunDB
from ..services.agent_task_outcome import build_failure_breakdown
from ..services.agent_task_scheduler import (
    compute_next_run_at,
    validate_schedule_fields,
)
from ..services.demo_workspace import require_project_not_demo
from ..services.project_memberships import enforce_project_role_from_request
from ..services.project_task_sources import get_task_source_db
from ..services.agent_task_runner import (
    create_batch_run,
    start_batch_run_execution,
)
from ..services.project_task_source_sync import SyncError

router = APIRouter(prefix="/v1", tags=["agent-tasks"])


def _count_consecutive_failures(
    session: Session, schedule_id: str, project: str
) -> int:
    """Count consecutive failing batch runs from the most recent for this schedule."""
    recent = session.exec(
        select(AgentTaskBatchRunDB)
        .where(AgentTaskBatchRunDB.project == project)
        .order_by(desc(_as_column(cast(object, AgentTaskBatchRunDB.created_at))))
        .limit(20)
    ).all()

    count = 0
    for batch in recent:
        meta = batch.run_metadata or {}
        sched = meta.get("schedule")
        if not isinstance(sched, dict) or sched.get("id") != schedule_id:
            continue
        if batch.status in ("completed", "error") and (
            batch.failed_tasks > 0 or batch.errored_tasks > 0
        ):
            count += 1
        else:
            break
    return count


def _format_schedule(
    schedule: AgentTaskScheduleDB, session: Session | None = None
) -> AgentTaskScheduleSummary:
    last_batch: ScheduleLastBatchSummary | None = None
    consecutive_failures = 0

    if schedule.last_batch_run_id and session is not None:
        batch = session.get(AgentTaskBatchRunDB, schedule.last_batch_run_id)
        if batch:
            task_runs = session.exec(
                select(AgentTaskRunDB).where(
                    AgentTaskRunDB.batch_run_id == batch.id
                )
            ).all()
            last_batch = ScheduleLastBatchSummary(
                id=batch.id,
                status=batch.status,
                total_tasks=batch.total_tasks,
                passed_tasks=batch.passed_tasks,
                failed_tasks=batch.failed_tasks,
                errored_tasks=batch.errored_tasks,
                created_at=batch.created_at,
                completed_at=batch.completed_at,
                failure_breakdown=build_failure_breakdown(task_runs),
            )
            consecutive_failures = _count_consecutive_failures(
                session, schedule.id, schedule.project
            )

    return AgentTaskScheduleSummary(
        id=schedule.id,
        project=schedule.project,
        name=schedule.name,
        selection_type=schedule.selection_type,
        selection_query=schedule.selection_query,
        task_root=schedule.task_root,
        grep=schedule.grep,
        environment=schedule.environment,
        cadence_type=schedule.cadence_type,
        timezone=schedule.timezone,
        hour=schedule.hour,
        minute=schedule.minute,
        day_of_week=schedule.day_of_week,
        day_of_month=schedule.day_of_month,
        min_interval_days=schedule.min_interval_days,
        max_interval_days=schedule.max_interval_days,
        enabled=schedule.enabled,
        last_triggered_at=schedule.last_triggered_at,
        last_batch_run_id=schedule.last_batch_run_id,
        next_run_at=schedule.next_run_at,
        created_at=schedule.created_at,
        updated_at=schedule.updated_at,
        last_batch=last_batch,
        consecutive_failures=consecutive_failures,
    )


def _format_schedule_detail(
    schedule: AgentTaskScheduleDB, session: Session | None = None
) -> AgentTaskScheduleDetail:
    base = _format_schedule(schedule, session)
    return AgentTaskScheduleDetail(
        **base.model_dump(),
        run_metadata=schedule.run_metadata,
    )


@router.get("/agent-task-schedules", response_model=list[AgentTaskScheduleSummary])
async def list_agent_task_schedules(
    project: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    query = select(AgentTaskScheduleDB).order_by(
        desc(_as_column(cast(object, AgentTaskScheduleDB.created_at)))
    )
    if project:
        query = query.where(AgentTaskScheduleDB.project == project)
    schedules = session.exec(query).all()
    return [_format_schedule(schedule, session) for schedule in schedules]


@router.get("/agent-task-schedules/{schedule_id}", response_model=AgentTaskScheduleDetail)
async def get_agent_task_schedule(
    schedule_id: str,
    session: Session = Depends(get_session),
):
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _format_schedule_detail(schedule, session)


@router.get(
    "/agent-task-schedules/{schedule_id}/adaptive-states",
    response_model=list[AdaptiveTaskStateSummary],
)
async def get_adaptive_states(
    schedule_id: str,
    session: Session = Depends(get_session),
):
    """Per-task adaptive scheduling state for display."""
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if schedule.cadence_type != "adaptive":
        return []
    states = session.exec(
        select(AdaptiveTaskStateDB)
        .where(AdaptiveTaskStateDB.schedule_id == schedule_id)
        .order_by(AdaptiveTaskStateDB.task_id)
    ).all()
    return [
        AdaptiveTaskStateSummary(
            task_id=s.task_id,
            task_path=s.task_path,
            current_interval_days=s.current_interval_days,
            ease_factor=s.ease_factor,
            consecutive_passes=s.consecutive_passes,
            last_run_at=s.last_run_at,
            last_status=s.last_status,
            next_run_at=s.next_run_at,
        )
        for s in states
    ]


@router.post("/agent-task-schedules", response_model=AgentTaskScheduleDetail, status_code=201)
async def create_agent_task_schedule(
    request: CreateAgentTaskScheduleRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    require_project_not_demo(request.project)
    # SPEC-122: schedule creation requires project admin role.
    _ = enforce_project_role_from_request(
        http_request, session, request.project, minimum_role="admin"
    )
    try:
        validate_schedule_fields(
            selection_type=request.selection_type,
            cadence_type=request.cadence_type,
            timezone_name=request.timezone,
            hour=request.hour,
            minute=request.minute,
            day_of_week=request.day_of_week,
            day_of_month=request.day_of_month,
            min_interval_days=request.min_interval_days,
            max_interval_days=request.max_interval_days,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    now = datetime.now(timezone.utc)
    # SPEC-119: snapshot the project's current task source so the
    # schedule stays explainable after later syncs. ``commit_sha`` is
    # intentionally not stored — schedules run against the moving ref
    # and the per-batch run captures the resolved SHA at trigger time.
    task_source = get_task_source_db(session, request.project)
    task_source_type = task_source.source_type if task_source else None
    task_source_ref = (
        _schedule_source_ref(task_source) if task_source else None
    )
    task_source_subpath = task_source.subpath if task_source else None

    schedule = AgentTaskScheduleDB(
        id=uuid4().hex[:16],
        project=request.project,
        name=request.name,
        selection_type=request.selection_type,
        selection_query={"task_paths": request.task_paths} if request.task_paths else None,
        task_root=request.task_root,
        grep=request.grep,
        environment=request.environment,
        cadence_type=request.cadence_type,
        timezone=request.timezone,
        hour=request.hour,
        minute=request.minute,
        day_of_week=request.day_of_week,
        day_of_month=request.day_of_month,
        min_interval_days=request.min_interval_days,
        max_interval_days=request.max_interval_days,
        enabled=request.enabled,
        run_metadata=request.run_metadata,
        next_run_at=compute_next_run_at(
            cadence_type=request.cadence_type,
            timezone_name=request.timezone,
            hour=request.hour,
            minute=request.minute,
            day_of_week=request.day_of_week,
            day_of_month=request.day_of_month,
            from_time=now,
            min_interval_days=request.min_interval_days,
        )
        if request.enabled
        else None,
        task_source_type=task_source_type,
        task_source_ref=task_source_ref,
        task_source_subpath=task_source_subpath,
        created_at=now,
        updated_at=now,
    )
    session.add(schedule)
    session.commit()
    session.refresh(schedule)
    return _format_schedule_detail(schedule, session)


def _schedule_source_ref(source: object) -> str | None:
    """Return the schedule's source ref label.

    Mirrors the ref stored on inventory rows so a schedule's source
    selection can be displayed without joining back to the source row.
    """
    source_type = getattr(source, "source_type", None)
    if source_type == "git":
        return getattr(source, "git_ref", None)
    if source_type == "filesystem":
        return getattr(source, "filesystem_path", None)
    if source_type == "demo":
        return getattr(source, "demo_seed_id", None)
    return None


@router.patch("/agent-task-schedules/{schedule_id}", response_model=AgentTaskScheduleDetail)
async def update_agent_task_schedule(
    schedule_id: str,
    request: UpdateAgentTaskScheduleRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")

    require_project_not_demo(schedule.project)
    # SPEC-122: schedule updates require project admin role.
    _ = enforce_project_role_from_request(
        http_request, session, schedule.project, minimum_role="admin"
    )

    if request.name is not None:
        schedule.name = request.name
    if request.task_paths is not None:
        schedule.selection_query = (
            {"task_paths": request.task_paths} if request.task_paths else None
        )
    if request.task_root is not None:
        schedule.task_root = request.task_root
    if request.grep is not None:
        schedule.grep = request.grep
    if request.environment is not None:
        schedule.environment = request.environment
    if request.cadence_type is not None:
        schedule.cadence_type = request.cadence_type
    if request.timezone is not None:
        schedule.timezone = request.timezone
    if request.hour is not None:
        schedule.hour = request.hour
    if request.minute is not None:
        schedule.minute = request.minute
    if request.day_of_week is not None or schedule.cadence_type != "weekly":
        schedule.day_of_week = request.day_of_week
    if request.day_of_month is not None or schedule.cadence_type != "monthly":
        schedule.day_of_month = request.day_of_month
    if request.min_interval_days is not None:
        schedule.min_interval_days = request.min_interval_days
    if request.max_interval_days is not None:
        schedule.max_interval_days = request.max_interval_days
    if request.enabled is not None:
        schedule.enabled = request.enabled
    if request.run_metadata is not None:
        schedule.run_metadata = request.run_metadata

    try:
        validate_schedule_fields(
            selection_type=schedule.selection_type,
            cadence_type=schedule.cadence_type,
            timezone_name=schedule.timezone,
            hour=schedule.hour,
            minute=schedule.minute,
            day_of_week=schedule.day_of_week,
            day_of_month=schedule.day_of_month,
            min_interval_days=schedule.min_interval_days,
            max_interval_days=schedule.max_interval_days,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    schedule.updated_at = datetime.now(timezone.utc)
    schedule.next_run_at = (
        compute_next_run_at(
            cadence_type=schedule.cadence_type,
            timezone_name=schedule.timezone,
            hour=schedule.hour,
            minute=schedule.minute,
            day_of_week=schedule.day_of_week,
            day_of_month=schedule.day_of_month,
            from_time=datetime.now(timezone.utc),
            min_interval_days=schedule.min_interval_days,
        )
        if schedule.enabled
        else None
    )
    session.add(schedule)
    session.commit()
    session.refresh(schedule)
    return _format_schedule_detail(schedule, session)


@router.post("/agent-task-schedules/{schedule_id}/trigger")
async def trigger_schedule(
    schedule_id: str,
    http_request: Request,
    session: Session = Depends(get_session),
):
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")

    require_project_not_demo(schedule.project)
    # SPEC-122: triggering a schedule is a write operation; requires admin.
    _ = enforce_project_role_from_request(
        http_request, session, schedule.project, minimum_role="admin"
    )

    now = datetime.now(timezone.utc)

    task_paths = None
    if schedule.selection_query and isinstance(schedule.selection_query, dict):
        raw = schedule.selection_query.get("task_paths")
        if isinstance(raw, list):
            task_paths = [p for p in raw if isinstance(p, str)] or None

    run_metadata = dict(schedule.run_metadata) if schedule.run_metadata else {}
    trigger = run_metadata.get("trigger")
    if isinstance(trigger, dict):
        trigger = dict(trigger)
    else:
        trigger = {}
    trigger["source"] = "schedule"
    trigger["schedule_id"] = schedule.id
    trigger["schedule_name"] = schedule.name
    trigger["initiated_at"] = now.isoformat()
    run_metadata["trigger"] = trigger
    run_metadata["schedule"] = {"id": schedule.id, "name": schedule.name}

    try:
        batch = create_batch_run(
            session,
            project=schedule.project,
            selection_type=schedule.selection_type,
            task_paths=task_paths,
            task_root=schedule.task_root,
            grep=schedule.grep,
            environment=schedule.environment,
            run_metadata=run_metadata,
            task_source=get_task_source_db(session, schedule.project),
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except SyncError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    schedule.last_triggered_at = now
    schedule.last_batch_run_id = batch.id
    session.add(schedule)
    session.commit()
    session.refresh(schedule)

    start_batch_run_execution(batch.id)

    return {
        "ok": True,
        "batch_run_id": batch.id,
        "schedule": _format_schedule(schedule, session),
    }


@router.delete("/agent-task-schedules/{schedule_id}")
async def delete_agent_task_schedule(
    schedule_id: str,
    http_request: Request,
    session: Session = Depends(get_session),
):
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    require_project_not_demo(schedule.project)
    # SPEC-122: schedule deletion requires project admin role.
    _ = enforce_project_role_from_request(
        http_request, session, schedule.project, minimum_role="admin"
    )
    session.delete(schedule)
    session.commit()
    return {"ok": True}
