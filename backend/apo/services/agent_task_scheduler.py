"""
Agent task schedule service.

Schedules create normal agent-task batch runs when they become due.
"""

import asyncio
import calendar
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, select

from ..db import engine
from ..db_helpers import as_column
from ..models.db import AgentTaskScheduleDB, ProjectTaskSourceDB
from .adaptive_scheduler import (
    compute_adaptive_next_run_at,
    recompute_schedule_next_run,
    select_due_task_ids,
)
from .execution_queue import (
    PoolResolutionError,
    create_pooled_batch_run,
    resolve_execution_pool,
)
from .project_task_inventory import task_source_inventory_is_stale
from .project_task_sources import get_task_source_db

logger = logging.getLogger(__name__)

SCHEDULE_POLL_INTERVAL_SECONDS = 30

_scheduler_thread: threading.Thread | None = None
_scheduler_stop_event = threading.Event()


def compute_next_run_at(
    *,
    cadence_type: str,
    timezone_name: str,
    hour: int,
    minute: int,
    day_of_week: int | None = None,
    day_of_month: int | None = None,
    from_time: datetime | None = None,
    min_interval_days: float = 1.0,
) -> datetime:
    zone = _get_timezone(timezone_name)
    now_utc = from_time or datetime.now(timezone.utc)
    local_now = now_utc.astimezone(zone).replace(second=0, microsecond=0)

    if cadence_type == "adaptive":
        return compute_adaptive_next_run_at(
            interval_days=min_interval_days,
            base_hour=hour,
            base_timezone=timezone_name,
            from_time=now_utc,
        )

    if cadence_type == "daily":
        candidate = local_now.replace(hour=hour, minute=minute)
        if candidate <= local_now:
            candidate = candidate + timedelta(days=1)
        return candidate.astimezone(timezone.utc)

    if cadence_type == "weekly":
        if day_of_week is None:
            raise ValueError("day_of_week is required for weekly schedules")
        candidate = local_now.replace(hour=hour, minute=minute)
        days_ahead = (day_of_week - candidate.weekday()) % 7
        candidate = candidate + timedelta(days=days_ahead)
        if candidate <= local_now:
            candidate = candidate + timedelta(days=7)
        return candidate.astimezone(timezone.utc)

    if cadence_type == "monthly":
        if day_of_month is None:
            raise ValueError("day_of_month is required for monthly schedules")
        candidate = _monthly_candidate(
            local_now, hour=hour, minute=minute, day_of_month=day_of_month
        )
        if candidate <= local_now:
            next_month = _increment_month(local_now)
            candidate = _monthly_candidate(
                next_month, hour=hour, minute=minute, day_of_month=day_of_month
            )
        return candidate.astimezone(timezone.utc)

    raise ValueError(f"Unsupported cadence_type: {cadence_type}")


def validate_schedule_fields(
    *,
    selection_type: str,
    cadence_type: str,
    timezone_name: str,
    hour: int,
    minute: int,
    day_of_week: int | None,
    day_of_month: int | None,
    min_interval_days: float | None = None,
    max_interval_days: float | None = None,
) -> None:
    if selection_type not in {"task", "tasks", "folder", "all"}:
        raise ValueError("selection_type must be one of task, tasks, folder, all")

    if cadence_type not in {"daily", "weekly", "monthly", "adaptive"}:
        raise ValueError(
            "cadence_type must be one of daily, weekly, monthly, adaptive"
        )

    if hour < 0 or hour > 23:
        raise ValueError("hour must be between 0 and 23")
    if minute < 0 or minute > 59:
        raise ValueError("minute must be between 0 and 59")

    _ = _get_timezone(timezone_name)

    if cadence_type == "weekly" and (day_of_week is None or day_of_week < 0 or day_of_week > 6):
        raise ValueError("day_of_week must be between 0 and 6 for weekly schedules")

    if cadence_type == "monthly" and (
        day_of_month is None or day_of_month < 1 or day_of_month > 31
    ):
        raise ValueError("day_of_month must be between 1 and 31 for monthly schedules")

    if cadence_type == "adaptive":
        min_days = 1.0 if min_interval_days is None else min_interval_days
        max_days = 30.0 if max_interval_days is None else max_interval_days
        if min_days < 1:
            raise ValueError("min_interval_days must be at least 1")
        if max_days < 1:
            raise ValueError("max_interval_days must be at least 1")
        if min_days > max_days:
            raise ValueError("min_interval_days must be <= max_interval_days")


def run_due_schedules_once() -> int:
    now = datetime.now(timezone.utc)
    created_batch_ids: list[str] = []

    with Session(engine) as session:
        schedules = session.exec(
            select(AgentTaskScheduleDB).where(
                AgentTaskScheduleDB.enabled == True,  # noqa: E712
                as_column(cast(object, AgentTaskScheduleDB.next_run_at)).is_not(None),
                as_column(cast(object, AgentTaskScheduleDB.next_run_at)) <= now,
            )
        ).all()

        for schedule in schedules:
            # source-owned schedules dispatch through the idempotent
            # Occurrence delivery path; legacy bundled schedules keep the
            # pooled path until the retirement spec handles them.
            if schedule.execution_kind == "source_owned":
                result = _dispatch_source_owned_schedule(
                    session, schedule=schedule, now=now
                )
                if result.created and result.batch_run_id:
                    created_batch_ids.append(result.batch_run_id)
                continue

            try:
                _ = resolve_execution_pool(
                    session,
                    project_id=schedule.project,
                    explicit_pool_id=schedule.executor_pool_id,
                )
            except PoolResolutionError as error:
                schedule.enabled = False
                schedule.disabled_reason = error.kind
                schedule.next_run_at = None
                session.add(schedule)
                continue
            task_source = get_task_source_db(session, schedule.project)
            if task_source is not None:
                if task_source.status != "ready":
                    logger.info(
                        "Skipping schedule %s because task source is %s",
                        schedule.id,
                        task_source.status,
                    )
                    continue
                if task_source_inventory_is_stale(session, task_source):
                    logger.info(
                        "Skipping schedule %s because task inventory is stale",
                        schedule.id,
                    )
                    continue

            if schedule.cadence_type == "adaptive":
                due_task_ids = select_due_task_ids(
                    session, schedule, task_source, now
                )
                if not due_task_ids:
                    schedule.next_run_at = recompute_schedule_next_run(
                        session, schedule, fallback_from_time=now
                    )
                    session.add(schedule)
                    continue

                batch_id, _ = _create_scheduled_batch(
                    session, schedule=schedule, task_source=task_source,
                    selection_type="tasks", task_paths=due_task_ids,
                )
                created_batch_ids.append(batch_id)

                schedule.last_triggered_at = now
                schedule.last_batch_run_id = batch_id
                # Temporary safety value: the post-batch adaptive update
                # (see ``_update_adaptive_state_if_needed``) overwrites this
                # with the earliest task-state next_run_at once the batch
                # finishes. Without it the 30s poller would re-trigger.
                schedule.next_run_at = now + timedelta(
                    days=schedule.max_interval_days
                )
                session.add(schedule)
                continue

            batch_id, _ = _create_scheduled_batch(
                session, schedule=schedule, task_source=task_source,
                selection_type=schedule.selection_type,
                task_paths=_selection_task_paths(schedule.selection_query),
            )
            created_batch_ids.append(batch_id)

            schedule.last_triggered_at = now
            schedule.last_batch_run_id = batch_id
            schedule.next_run_at = compute_next_run_at(
                cadence_type=schedule.cadence_type,
                timezone_name=schedule.timezone,
                hour=schedule.hour,
                minute=schedule.minute,
                day_of_week=schedule.day_of_week,
                day_of_month=schedule.day_of_month,
                from_time=now + timedelta(minutes=1),
            )
            session.add(schedule)

        session.commit()

    return len(created_batch_ids)


def start_schedule_dispatcher() -> None:
    global _scheduler_thread

    if _scheduler_thread is not None and _scheduler_thread.is_alive():
        return

    _scheduler_stop_event.clear()
    _scheduler_thread = threading.Thread(
        target=_scheduler_loop,
        name="agent-task-scheduler",
        daemon=True,
    )
    _scheduler_thread.start()


def stop_schedule_dispatcher() -> None:
    _scheduler_stop_event.set()


def _create_scheduled_batch(
    session: Session,
    *,
    schedule: AgentTaskScheduleDB,
    task_source: ProjectTaskSourceDB | None,
    selection_type: str,
    task_paths: list[str] | None,
) -> tuple[str, bool]:
    """Create a Batch for a due schedule.

    Returns ``(batch_id, True)`` after durable pooled work is created.
    """
    pool_id = schedule.executor_pool_id
    if pool_id is None:
        raise PoolResolutionError(
            "executor_pool_required",
            "schedule has no executor pool",
        )
    batch = asyncio.run(
        create_pooled_batch_run(
            session,
            project_id=schedule.project,
            pool_id=pool_id,
            selection_type=selection_type,
            task_paths=task_paths,
            task_root=schedule.task_root,
            grep=schedule.grep,
            environment=schedule.environment,
            run_metadata=_schedule_run_metadata(schedule),
            task_source=task_source,
            queue_ttl_seconds=schedule.queue_ttl_seconds,
        )
    )
    return batch.id, True


def _scheduler_loop() -> None:
    try:
        _ = run_due_schedules_once()
    except Exception:
        logger.exception("Initial schedule dispatch failed")

    while not _scheduler_stop_event.wait(SCHEDULE_POLL_INTERVAL_SECONDS):
        try:
            _ = run_due_schedules_once()
        except Exception:
            logger.exception("Schedule dispatch failed")


def _schedule_run_metadata(
    schedule: AgentTaskScheduleDB,
) -> dict[str, object] | None:
    metadata = dict(schedule.run_metadata) if schedule.run_metadata else {}
    trigger = metadata.get("trigger")
    trigger_dict = (
        dict(cast(dict[str, object], trigger)) if isinstance(trigger, dict) else {}
    )
    trigger_dict["source"] = "schedule"
    if "entrypoint" not in trigger_dict:
        trigger_dict["entrypoint"] = "/agent-task-schedules"
    trigger_dict["initiated_at"] = datetime.now(timezone.utc).isoformat()
    metadata["trigger"] = trigger_dict
    metadata["schedule"] = {
        "id": schedule.id,
        "name": schedule.name,
    }
    return metadata


def _selection_task_paths(
    selection_query: dict[str, object] | None,
) -> list[str] | None:
    if not selection_query:
        return None
    raw = selection_query.get("task_paths")
    if not isinstance(raw, list):
        return None
    raw_items = cast(list[object], raw)
    result: list[str] = []
    for item in raw_items:
        if isinstance(item, str):
            result.append(item)
    return result


def _get_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone: {name}") from exc


def _monthly_candidate(
    local_now: datetime,
    *,
    hour: int,
    minute: int,
    day_of_month: int,
) -> datetime:
    last_day = calendar.monthrange(local_now.year, local_now.month)[1]
    safe_day = min(day_of_month, last_day)
    return local_now.replace(day=safe_day, hour=hour, minute=minute)


def _increment_month(value: datetime) -> datetime:
    if value.month == 12:
        return value.replace(year=value.year + 1, month=1, day=1)
    return value.replace(month=value.month + 1, day=1)


def _dispatch_source_owned_schedule(
    session: Session,
    *,
    schedule: AgentTaskScheduleDB,
    now: datetime,
):
    """Deliver one Occurrence for a due source-owned Schedule.

    Returns the ``OccurrenceDeliveryResult`` so the caller can count created
    Batches. The Occurrence+Batch+pointer+cadence advance share one
    transaction owned by ``run_due_schedules_once``'s final commit, so a crash
    between delivery and advancement rolls back cleanly (the unique Occurrence
    identity makes any retry a delivery retry, not a duplicate).
    """
    from apo.services.schedule_occurrences import (
        OccurrenceDeliveryResult,
        deliver_due_occurrence,
        owner_is_project_member,
    )

    # Crash/recovery protection: pause if the fixed owner left the Project.
    if not owner_is_project_member(session, schedule=schedule):
        schedule.enabled = False
        schedule.disabled_reason = "execution_owner_unavailable"
        schedule.next_run_at = None
        session.add(schedule)
        return OccurrenceDeliveryResult(
            occurrence_id="", batch_run_id=None, created=False, missed_reason=None
        )

    result = deliver_due_occurrence(session, schedule=schedule, now=now)

    # Advance directly to the next future cadence from the dispatch moment
    # (not the nominal due time) so a catch-up after prolonged disconnection
    # never lands on a slot that is already in the past.
    schedule.next_run_at = _next_run_after(
        schedule=schedule, from_time=now + timedelta(minutes=1)
    )
    session.add(schedule)
    return result


def _next_run_after(
    *,
    schedule: AgentTaskScheduleDB,
    from_time: datetime,
) -> datetime:
    if schedule.cadence_type == "adaptive":
        from apo.services.adaptive_scheduler import recompute_schedule_next_run

        active_session = cast(Session, Session.object_session(schedule)) or Session(engine)
        return recompute_schedule_next_run(
            active_session,
            schedule,
            fallback_from_time=from_time,
        )
    return compute_next_run_at(
        cadence_type=schedule.cadence_type,
        timezone_name=schedule.timezone,
        hour=schedule.hour,
        minute=schedule.minute,
        day_of_week=schedule.day_of_week,
        day_of_month=schedule.day_of_month,
        from_time=from_time,
    )
