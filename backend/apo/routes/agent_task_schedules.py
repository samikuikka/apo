"""
Agent task schedule API endpoints.
"""

# pyright: reportCallInDefaultInitializer=false, reportUnusedCallResult=false

from datetime import datetime, timezone
from typing import Literal, cast
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import desc
from sqlmodel import Session, col, select

from ..db import get_session
from ..db_helpers import as_column
from ..models import (
    AdaptiveTaskStateSummary,
    AgentTaskBatchRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleDetail,
    AgentTaskScheduleSummary,
    CreateAgentTaskScheduleRequest,
    ScheduleExecutionOwnerSummary,
    ScheduleOccurrenceSummary,
    TriggerScheduleResponse,
    UpdateAgentTaskScheduleRequest,
)
from ..models.schemas import ScheduleLastBatchSummary
from ..models.db import AdaptiveTaskStateDB, AgentTaskRunDB
from ..services.lifecycle import BATCH_RUN_TERMINAL
from ..services.agent_task_outcome import build_failure_breakdown
from ..services.agent_task_scheduler import (
    compute_next_run_at,
    validate_schedule_fields,
)
from ..services.demo_workspace import require_project_not_demo
from ..services.project_memberships import (
    enforce_project_role_from_request,
    readable_project_ids_for_request,
)
from ..services.project_task_sources import get_task_source_db
from ..services.project_task_source_sync import SyncError

router = APIRouter(prefix="/v1", tags=["agent-tasks"])


def _count_consecutive_failures(
    session: Session, schedule_id: str, project: str
) -> int:
    """Count consecutive failing batch runs from the most recent for this schedule."""
    recent = session.exec(
        select(AgentTaskBatchRunDB)
        .where(AgentTaskBatchRunDB.project == project)
        .order_by(desc(as_column(cast(object, AgentTaskBatchRunDB.created_at))))
        .limit(20)
    ).all()

    count = 0
    for batch in recent:
        meta = batch.run_metadata or {}
        raw_schedule = meta.get("schedule")
        if not isinstance(raw_schedule, dict):
            continue
        schedule_metadata = cast(dict[str, object], raw_schedule)
        if schedule_metadata.get("id") != schedule_id:
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
        executor_pool_id=schedule.executor_pool_id,
        queue_ttl_seconds=schedule.queue_ttl_seconds,
        disabled_reason=schedule.disabled_reason,
        last_triggered_at=schedule.last_triggered_at,
        last_batch_run_id=schedule.last_batch_run_id,
        next_run_at=schedule.next_run_at,
        created_at=schedule.created_at,
        updated_at=schedule.updated_at,
        last_batch=last_batch,
        consecutive_failures=consecutive_failures,
        execution_kind=cast("Literal['source_owned', 'bundled']", schedule.execution_kind),
        execution_owner=_execution_owner_summary(session, schedule),
        connected_environment_state=_connected_environment_state(session, schedule),
        active_batch_run_id=schedule.active_batch_run_id,
        latest_occurrence=_latest_occurrence(session, schedule),
        missed_occurrences=_missed_occurrence_count(session, schedule),
    )


def _execution_owner_summary(
    session: Session | None, schedule: AgentTaskScheduleDB
) -> ScheduleExecutionOwnerSummary | None:
    if not schedule.execution_owner_user_id or session is None:
        return None
    from apo.models.db import UserDB

    user = session.get(UserDB, schedule.execution_owner_user_id)
    if user is None:
        return None
    return ScheduleExecutionOwnerSummary(id=user.id, name=user.name)


def _connected_environment_state(
    session: Session | None, schedule: AgentTaskScheduleDB
) -> str | None:
    if schedule.execution_kind != "source_owned" or session is None:
        return None
    if not schedule.execution_owner_user_id:
        return None
    from apo.services.schedule_occurrences import schedule_connected_environment_state

    state = schedule_connected_environment_state(session, schedule=schedule)
    return str(state) if state is not None else None


def _latest_occurrence(
    session: Session | None, schedule: AgentTaskScheduleDB
) -> ScheduleOccurrenceSummary | None:
    if session is None:
        return None
    from apo.models.db import AgentTaskScheduleOccurrenceDB

    occ = session.exec(
        select(AgentTaskScheduleOccurrenceDB)
        .where(AgentTaskScheduleOccurrenceDB.schedule_id == schedule.id)
        .order_by(desc(as_column(cast(object, AgentTaskScheduleOccurrenceDB.scheduled_for))))
        .limit(1)
    ).first()
    if occ is None:
        return None
    return ScheduleOccurrenceSummary(
        id=occ.id,
        kind=cast("Literal['scheduled', 'manual']", occ.kind),
        scheduled_for=occ.scheduled_for,
        status=cast("Literal['pending', 'delivered', 'missed', 'cancelled']", occ.status),
        batch_run_id=occ.batch_run_id,
        missed_reason=cast(
            "Literal['previous_occurrence_active', 'executor_unavailable', 'catalog_changed', 'selection_empty'] | None",
            occ.missed_reason,
        ),
        resolved_at=occ.resolved_at,
    )


def _missed_occurrence_count(
    session: Session | None, schedule: AgentTaskScheduleDB
) -> int:
    if session is None:
        return 0
    from apo.models.db import AgentTaskScheduleOccurrenceDB

    return len(
        session.exec(
            select(AgentTaskScheduleOccurrenceDB).where(
                AgentTaskScheduleOccurrenceDB.schedule_id == schedule.id,
                AgentTaskScheduleOccurrenceDB.status == "missed",
            )
        ).all()
    )


def _format_schedule_detail(
    schedule: AgentTaskScheduleDB, session: Session | None = None
) -> AgentTaskScheduleDetail:
    base = _format_schedule(schedule, session)
    payload = cast(dict[str, object], base.model_dump())
    payload["run_metadata"] = schedule.run_metadata
    return AgentTaskScheduleDetail.model_validate(payload)


@router.get("/agent-task-schedules", response_model=list[AgentTaskScheduleSummary])
async def list_agent_task_schedules(
    request: Request,
    project: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> list[AgentTaskScheduleSummary]:
    """List Schedules readable by the caller, newest first.

    Optional ``project`` filter requires viewer role; without it the list is
    scoped to all the caller's readable Projects.
    """
    # Scope by readable Projects.
    if project:
        enforce_project_role_from_request(
            request, session, project, minimum_role="viewer"
        )
        project_ids: list[str] | None = [project]
    else:
        project_ids = readable_project_ids_for_request(request, session)

    query = select(AgentTaskScheduleDB).order_by(
        desc(as_column(cast(object, AgentTaskScheduleDB.created_at)))
    )
    if project_ids is not None:
        query = query.where(col(AgentTaskScheduleDB.project).in_(project_ids))
    elif project:
        query = query.where(AgentTaskScheduleDB.project == project)
    schedules = session.exec(query).all()
    return [_format_schedule(schedule, session) for schedule in schedules]


@router.get("/agent-task-schedules/{schedule_id}", response_model=AgentTaskScheduleDetail)
async def get_agent_task_schedule(
    request: Request,
    schedule_id: str,
    session: Session = Depends(get_session),
) -> AgentTaskScheduleDetail:
    """Return one Schedule with full metadata. Cross-Project access is masked as 404."""
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    # Authorize after load — deny cross-Project access with 404.
    try:
        enforce_project_role_from_request(
            request, session, schedule.project, minimum_role="viewer"
        )
    except HTTPException as exc:
        if exc.status_code == 403:
            raise HTTPException(status_code=404, detail="Schedule not found") from exc
        raise
    return _format_schedule_detail(schedule, session)


@router.get(
    "/agent-task-schedules/{schedule_id}/adaptive-states",
    response_model=list[AdaptiveTaskStateSummary],
)
async def get_adaptive_states(
    request: Request,
    schedule_id: str,
    session: Session = Depends(get_session),
) -> list[AdaptiveTaskStateSummary]:
    """Per-task adaptive scheduling state for display."""
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    # Authorize after load — deny cross-Project access with 404.
    try:
        enforce_project_role_from_request(
            request, session, schedule.project, minimum_role="viewer"
        )
    except HTTPException as exc:
        if exc.status_code == 403:
            raise HTTPException(status_code=404, detail="Schedule not found") from exc
        raise
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
    """Create a Schedule. Project admin only; not allowed on the demo Project.

    A typed catalog ``selection`` creates a source-owned Schedule; otherwise
    the legacy pooled path applies. Returns 201.
    """
    require_project_not_demo(request.project)
    # schedule creation requires project admin role.
    membership = enforce_project_role_from_request(
        http_request, session, request.project, minimum_role="admin"
    )

    # a typed catalog ``selection`` creates a source-owned Schedule
    # bound to the authenticated admin as fixed Execution Owner. Legacy
    # bundled schedules keep the Pool/path path when ``selection`` is absent.
    if request.selection is not None:
        return _create_source_owned_schedule(
            session, request=request, http_request=http_request, membership=membership
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
    # snapshot the project's current task source so the
    # schedule stays explainable after later syncs. ``commit_sha`` is
    # intentionally not stored — schedules run against the moving ref
    # and the per-batch run captures the resolved SHA at trigger time.
    task_source = get_task_source_db(session, request.project)
    task_source_type = task_source.source_type if task_source else None
    task_source_ref = (
        _schedule_source_ref(task_source) if task_source else None
    )
    task_source_subpath = task_source.subpath if task_source else None
    from ..services.execution_queue import (
        PoolResolutionError,
        resolve_execution_pool,
    )

    try:
        pool = resolve_execution_pool(
            session,
            project_id=request.project,
            explicit_pool_id=request.executor_pool_id,
        )
    except PoolResolutionError as error:
        raise HTTPException(
            status_code=409,
            detail={"kind": error.kind, "msg": str(error)},
        ) from error
    if request.queue_ttl_seconds <= 0:
        raise HTTPException(
            status_code=422,
            detail="queue_ttl_seconds must be positive",
        )

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
        executor_pool_id=pool.id,
        queue_ttl_seconds=request.queue_ttl_seconds,
        disabled_reason=None,
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


def _create_source_owned_schedule(
    session: Session,
    *,
    request: CreateAgentTaskScheduleRequest,
    http_request: Request,
    membership: object,
) -> AgentTaskScheduleDetail:
    """Persist a source-owned Schedule owned by the authed admin.

    The request may not carry an execution owner, Pool, Executor, task root,
    path, or grep. Selection is a typed catalog selector validated at dispatch.
    """
    if request.task_paths or request.task_root or request.grep or request.executor_pool_id:
        raise HTTPException(
            status_code=422,
            detail={
                "kind": "schedule_selection_invalid",
                "msg": "source-owned schedules accept a catalog selection only",
            },
        )
    selection = _validate_selection(cast(dict[str, object], request.selection))
    acting_user_id = cast(str | None, getattr(http_request.state, "user_id", None))
    owner_id = cast("str | None", getattr(membership, "user_id", None))
    if not acting_user_id or not owner_id or str(acting_user_id) != str(owner_id):
        raise HTTPException(
            status_code=401,
            detail="source-owned schedules require an authenticated project admin",
        )
    try:
        validate_schedule_fields(
            selection_type="tasks",
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
    schedule = AgentTaskScheduleDB(
        id=uuid4().hex[:16],
        project=request.project,
        name=request.name,
        selection_type="tasks",
        selection_query=selection,
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
        execution_kind="source_owned",
        execution_owner_user_id=str(owner_id),
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
        created_at=now,
        updated_at=now,
    )
    session.add(schedule)
    session.commit()
    session.refresh(schedule)
    return _format_schedule_detail(schedule, session)


def _validate_selection(raw: dict[str, object]) -> dict[str, object]:
    """Validate and normalize a typed catalog selection dict."""
    kind = raw.get("kind")
    if kind == "tasks":
        raw_ids = raw.get("task_ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise HTTPException(
                status_code=422,
                detail={"kind": "schedule_selection_invalid", "msg": "task_ids required"},
            )
        ids_list = cast(list[object], raw_ids)
        ids = [x for x in ids_list if isinstance(x, str)]
        if not ids or len(ids) != len(ids_list) or len(set(ids)) != len(ids):
            raise HTTPException(
                status_code=422,
                detail={"kind": "schedule_selection_invalid", "msg": "duplicate/empty task_ids"},
            )
        return {"kind": "tasks", "task_ids": ids}
    if kind == "folder":
        folder_id = raw.get("folder_id")
        if not isinstance(folder_id, str) or not folder_id:
            raise HTTPException(
                status_code=422,
                detail={"kind": "schedule_selection_invalid", "msg": "folder_id required"},
            )
        return {"kind": "folder", "folder_id": folder_id}
    if kind == "all":
        return {"kind": "all"}
    raise HTTPException(
        status_code=422,
        detail={"kind": "schedule_selection_invalid", "msg": "unknown selection kind"},
    )


@router.patch("/agent-task-schedules/{schedule_id}", response_model=AgentTaskScheduleDetail)
async def update_agent_task_schedule(
    schedule_id: str,
    request: UpdateAgentTaskScheduleRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    """Patch Schedule fields; recomputes ``next_run_at`` from the merged cadence.

    Project admin only. Pausing a source-owned Schedule cancels its
    never-started active Batch; resolved pool changes clear pool-related
    disabled reasons.
    """
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")

    require_project_not_demo(schedule.project)
    # schedule updates require project admin role.
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
        # pausing a source-owned Schedule cancels its never-started
        # active Batch; started work is left intact to finish.
        if schedule.execution_kind == "source_owned" and not request.enabled and schedule.enabled:
            from apo.services.execution_leases import cancel_active_batch_on_pause

            _cancelled_on_pause = cancel_active_batch_on_pause(
                session, schedule=schedule, now=datetime.now(timezone.utc)
            )
        schedule.enabled = request.enabled
    if request.run_metadata is not None:
        schedule.run_metadata = request.run_metadata
    if request.executor_pool_id is not None:
        from ..services.execution_queue import (
            PoolResolutionError,
            resolve_execution_pool,
        )

        try:
            pool = resolve_execution_pool(
                session,
                project_id=schedule.project,
                explicit_pool_id=request.executor_pool_id,
            )
        except PoolResolutionError as error:
            raise HTTPException(
                status_code=409,
                detail={"kind": error.kind, "msg": str(error)},
            ) from error
        schedule.executor_pool_id = pool.id
        if schedule.disabled_reason in {
            "executor_pool_required",
            "executor_pool_archived",
            "executor_pool_disabled",
        }:
            schedule.disabled_reason = None
    if request.queue_ttl_seconds is not None:
        if request.queue_ttl_seconds <= 0:
            raise HTTPException(
                status_code=422,
                detail="queue_ttl_seconds must be positive",
            )
        schedule.queue_ttl_seconds = request.queue_ttl_seconds

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
    """Run Now: trigger a Batch immediately. Project admin only; demo excluded.

    Source-owned Schedules deliver a manual Occurrence (or return the active
    Batch) without shifting the cadence; legacy bundled Schedules create a
    pooled Batch Run. Returns 409 on pool/selection conflicts.
    """
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")

    require_project_not_demo(schedule.project)
    # triggering a schedule is a write operation; requires admin.
    _ = enforce_project_role_from_request(
        http_request, session, schedule.project, minimum_role="admin"
    )

    # source-owned Run Now delivers a manual Occurrence (or returns
    # the active Batch) without shifting the cadence. Legacy bundled keeps
    # the pooled create-and-trigger path.
    if schedule.execution_kind == "source_owned":
        return _trigger_source_owned_schedule(session, schedule=schedule)

    now = datetime.now(timezone.utc)

    task_paths = None
    if schedule.selection_query:
        raw = schedule.selection_query.get("task_paths")
        if isinstance(raw, list):
            task_paths = [
                path for path in cast(list[object], raw) if isinstance(path, str)
            ] or None

    run_metadata = dict(schedule.run_metadata) if schedule.run_metadata else {}
    raw_trigger = run_metadata.get("trigger")
    if isinstance(raw_trigger, dict):
        trigger: dict[str, object] = dict(
            cast(dict[str, object], raw_trigger)
        )
    else:
        trigger = {}
    trigger["source"] = "schedule"
    trigger["schedule_id"] = schedule.id
    trigger["schedule_name"] = schedule.name
    trigger["initiated_at"] = now.isoformat()
    run_metadata["trigger"] = trigger
    run_metadata["schedule"] = {"id": schedule.id, "name": schedule.name}

    try:
        from apo.services.execution_queue import (
            PoolResolutionError,
            create_pooled_batch_run,
        )

        if schedule.executor_pool_id is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "kind": "executor_pool_required",
                    "msg": "schedule has no persisted executor pool",
                },
            )
        try:
            batch = await create_pooled_batch_run(
                session,
                project_id=schedule.project,
                pool_id=schedule.executor_pool_id,
                selection_type=schedule.selection_type,
                task_paths=task_paths,
                task_root=schedule.task_root,
                grep=schedule.grep,
                environment=schedule.environment,
                run_metadata=run_metadata,
                task_source=get_task_source_db(session, schedule.project),
                queue_ttl_seconds=schedule.queue_ttl_seconds,
            )
        except PoolResolutionError as error:
            raise HTTPException(
                status_code=409,
                detail={"kind": error.kind, "msg": str(error)},
            ) from error
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except SyncError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    schedule.last_triggered_at = now
    schedule.last_batch_run_id = batch.id
    session.add(schedule)
    session.commit()
    session.refresh(schedule)

    return {
        "ok": True,
        "batch_run_id": batch.id,
        "schedule": _format_schedule(schedule, session),
    }


def _trigger_source_owned_schedule(
    session: Session, *, schedule: AgentTaskScheduleDB
) -> TriggerScheduleResponse:
    """Run Now: return active work or create one manual Occurrence.

    Idempotent: if a non-terminal Batch already exists, return it with
    ``created=False``. Otherwise deliver a manual Occurrence targeted to the
    fixed Execution Owner. The cadence is never shifted by Run Now.
    """
    from apo.models.db import AgentTaskScheduleOccurrenceDB
    from apo.services.schedule_occurrences import deliver_due_occurrence

    # Hard-disabled states must be repaired before Run Now.
    if schedule.disabled_reason in (
        "execution_owner_unavailable",
        "catalog_changed",
        "selection_empty",
    ):
        raise HTTPException(
            status_code=409,
            detail={"kind": schedule.disabled_reason, "msg": "schedule is hard-paused"},
        )

    active_batch_id = schedule.active_batch_run_id
    if active_batch_id:
        active = session.get(AgentTaskBatchRunDB, active_batch_id)
        if active is not None and active.status not in BATCH_RUN_TERMINAL:
            occ = session.exec(
                select(AgentTaskScheduleOccurrenceDB).where(
                    AgentTaskScheduleOccurrenceDB.batch_run_id == active_batch_id
                )
            ).first()
            return TriggerScheduleResponse(
                batch_run_id=active.id,
                occurrence_id=occ.id if occ is not None else None,
                created=False,
                schedule=_format_schedule(schedule, session),
            )

    now = datetime.now(timezone.utc)
    # Run Now uses the current time as the manual Occurrence's scheduled_for.
    schedule.next_run_at = now
    session.add(schedule)
    session.flush()
    result = deliver_due_occurrence(session, schedule=schedule, now=now, kind="manual")
    # Run Now must not shift the normal cadence: restore next_run_at.
    schedule.next_run_at = _cadence_next_run(schedule, from_time=now)
    schedule.last_triggered_at = now
    if result.batch_run_id:
        schedule.last_batch_run_id = result.batch_run_id
    session.add(schedule)
    session.commit()
    session.refresh(schedule)
    return TriggerScheduleResponse(
        batch_run_id=result.batch_run_id,
        occurrence_id=result.occurrence_id,
        created=result.created,
        schedule=_format_schedule(schedule, session),
    )


def _cadence_next_run(schedule: AgentTaskScheduleDB, *, from_time: datetime) -> datetime | None:
    if not schedule.enabled:
        return None
    return compute_next_run_at(
        cadence_type=schedule.cadence_type,
        timezone_name=schedule.timezone,
        hour=schedule.hour,
        minute=schedule.minute,
        day_of_week=schedule.day_of_week,
        day_of_month=schedule.day_of_month,
        from_time=from_time,
        min_interval_days=schedule.min_interval_days,
    )


@router.get(
    "/agent-task-schedules/{schedule_id}/occurrences",
    response_model=dict,
)
async def list_schedule_occurrences(
    schedule_id: str,
    http_request: Request,
    session: Session = Depends(get_session),
    limit: int = Query(default=20, ge=1, le=100),
):
    """Bounded newest-first Occurrence history (Project members)."""
    from apo.models.db import AgentTaskScheduleOccurrenceDB

    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    _ = enforce_project_role_from_request(
        http_request, session, schedule.project, minimum_role="viewer"
    )
    rows = session.exec(
        select(AgentTaskScheduleOccurrenceDB)
        .where(AgentTaskScheduleOccurrenceDB.schedule_id == schedule_id)
        .order_by(desc(as_column(cast(object, AgentTaskScheduleOccurrenceDB.scheduled_for))))
        .limit(limit)
    ).all()
    return {
        "occurrences": [
            ScheduleOccurrenceSummary(
                id=row.id,
                kind=cast("Literal['scheduled', 'manual']", row.kind),
                scheduled_for=row.scheduled_for,
                status=cast(
                    "Literal['pending', 'delivered', 'missed', 'cancelled']", row.status
                ),
                batch_run_id=row.batch_run_id,
                missed_reason=cast(
                    "Literal['previous_occurrence_active', 'executor_unavailable', 'catalog_changed', 'selection_empty'] | None",
                    row.missed_reason,
                ),
                resolved_at=row.resolved_at,
            ).model_dump(mode="json")
            for row in rows
        ]
    }


@router.delete("/agent-task-schedules/{schedule_id}")
async def delete_agent_task_schedule(
    schedule_id: str,
    http_request: Request,
    session: Session = Depends(get_session),
):
    """Delete a Schedule and its dependents (occurrences, adaptive states).

    Project admin only; not allowed on the demo Project.
    """
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    require_project_not_demo(schedule.project)
    # schedule deletion requires project admin role.
    _ = enforce_project_role_from_request(
        http_request, session, schedule.project, minimum_role="admin"
    )
    # Dependents go first so deleting the schedule cannot orphan them:
    # occurrence history and per-task adaptive states are meaningless
    # without their schedule.
    from apo.models.db import AgentTaskScheduleOccurrenceDB

    occurrences = session.exec(
        select(AgentTaskScheduleOccurrenceDB).where(
            AgentTaskScheduleOccurrenceDB.schedule_id == schedule_id
        )
    ).all()
    for occurrence in occurrences:
        session.delete(occurrence)
    adaptive_states = session.exec(
        select(AdaptiveTaskStateDB).where(
            AdaptiveTaskStateDB.schedule_id == schedule_id
        )
    ).all()
    for state in adaptive_states:
        session.delete(state)
    session.delete(schedule)
    session.commit()
    return {"ok": True}
