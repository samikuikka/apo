"""
Agent task schedule service.

Schedules create normal agent-task batch runs when they become due.
"""

import calendar
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, select

from ..db import engine
from ..db_helpers import _as_column
from ..models.db import AgentTaskScheduleDB
from .adaptive_scheduler import (
    compute_adaptive_next_run_at,
    recompute_schedule_next_run,
    select_due_task_ids,
)
from .agent_task_runner import create_batch_run, start_batch_run_execution
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
                _as_column(cast(object, AgentTaskScheduleDB.next_run_at)).is_not(None),
                _as_column(cast(object, AgentTaskScheduleDB.next_run_at)) <= now,
            )
        ).all()

        for schedule in schedules:
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

                batch = create_batch_run(
                    session,
                    project=schedule.project,
                    selection_type="tasks",
                    task_paths=due_task_ids,
                    task_root=schedule.task_root,
                    grep=None,
                    environment=schedule.environment,
                    run_metadata=_schedule_run_metadata(schedule),
                    task_source=task_source,
                )
                created_batch_ids.append(batch.id)

                schedule.last_triggered_at = now
                schedule.last_batch_run_id = batch.id
                # Temporary safety value: the post-batch adaptive update
                # (see ``_update_adaptive_state_if_needed``) overwrites this
                # with the earliest task-state next_run_at once the batch
                # finishes. Without it the 30s poller would re-trigger.
                schedule.next_run_at = now + timedelta(
                    days=schedule.max_interval_days
                )
                session.add(schedule)
                continue

            batch = create_batch_run(
                session,
                project=schedule.project,
                selection_type=schedule.selection_type,
                task_paths=_selection_task_paths(schedule.selection_query),
                task_root=schedule.task_root,
                grep=schedule.grep,
                environment=schedule.environment,
                run_metadata=_schedule_run_metadata(schedule),
                task_source=task_source,
            )
            created_batch_ids.append(batch.id)

            schedule.last_triggered_at = now
            schedule.last_batch_run_id = batch.id
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

    for batch_id in created_batch_ids:
        start_batch_run_execution(batch_id)

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
