"""
Adaptive (SM-2 spaced-repetition) scheduling.

Each task in an adaptive schedule tracks its own interval and ease factor
independently. Passing tests back off exponentially (1d -> 2.5d -> 6.25d);
failing tests reset to the minimum interval. The schedule's next_run_at
is the earliest next-run across all its task states.

SPEC-069.
"""

import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, select

from ..models.db import (
    AdaptiveTaskStateDB,
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
)

logger = logging.getLogger(__name__)

MIN_EASE_FACTOR = 1.3
PASS_EASE_DELTA = 0.05
FAIL_EASE_DELTA = -0.2


def compute_adaptive_next_run(
    *,
    current_interval_days: float,
    ease_factor: float,
    consecutive_passes: int,
    passed: bool,
    min_interval_days: float,
    max_interval_days: float,
) -> tuple[float, float, int]:
    """Apply one SM-2 update step.

    Returns ``(new_interval_days, new_ease_factor, new_consecutive_passes)``.
    The interval is clamped to ``[min_interval_days, max_interval_days]`` and
    the ease factor is floored at :data:`MIN_EASE_FACTOR`.
    """
    if passed:
        new_interval = current_interval_days * ease_factor
        new_ease = max(MIN_EASE_FACTOR, ease_factor + PASS_EASE_DELTA)
        new_consecutive = consecutive_passes + 1
    else:
        new_interval = min_interval_days
        new_ease = max(MIN_EASE_FACTOR, ease_factor + FAIL_EASE_DELTA)
        new_consecutive = 0

    clamped = max(min_interval_days, min(new_interval, max_interval_days))
    return clamped, new_ease, new_consecutive


def compute_adaptive_next_run_at(
    *,
    interval_days: float,
    base_hour: int,
    base_timezone: str,
    from_time: datetime | None = None,
) -> datetime:
    """Compute the next run datetime for a given interval.

    Adds ``interval_days`` to ``from_time`` (default: now) and snaps the
    result to ``base_hour:00`` in ``base_timezone``. If snapping moves the
    target into the past relative to ``from_time``, one day is added so the
    returned datetime is always strictly in the future.
    """
    start = from_time or datetime.now(timezone.utc)
    raw_target = start + timedelta(days=interval_days)
    zone = _get_timezone(base_timezone)
    local = raw_target.astimezone(zone).replace(
        hour=base_hour, minute=0, second=0, microsecond=0
    )
    if local <= start:
        local = local + timedelta(days=1)
    return local.astimezone(timezone.utc)


def select_due_task_ids(
    session: Session,
    schedule: AgentTaskScheduleDB,
    task_source: ProjectTaskSourceDB | None,
    now: datetime,
) -> list[str]:
    """Return task_ids in the schedule's selection that are due to run.

    A task is due when it has no adaptive state yet (first run) or its
    state's ``next_run_at`` is at or before ``now``.
    """
    if task_source is None:
        # Expected state (e.g. demo schedules, or a project that hasn't
        # configured a task source yet) — not warning-worthy. The caller
        # reschedules the run, so this stays quiet at default log levels.
        logger.debug(
            "Adaptive schedule %s has no task source; cannot resolve tasks",
            schedule.id,
        )
        return []

    inventory_rows = _resolve_inventory(
        session,
        project=schedule.project,
        task_source=task_source,
        selection_type=schedule.selection_type,
        task_paths=_selection_task_paths(schedule.selection_query),
        grep=schedule.grep,
    )
    if not inventory_rows:
        return []

    states = session.exec(
        select(AdaptiveTaskStateDB).where(
            AdaptiveTaskStateDB.schedule_id == schedule.id
        )
    ).all()
    state_by_task_id: dict[str, AdaptiveTaskStateDB] = {
        s.task_id: s for s in states
    }

    due: list[str] = []
    for row in inventory_rows:
        state = state_by_task_id.get(row.task_id)
        if (
            state is None
            or state.next_run_at is None
            or _ensure_utc(state.next_run_at) <= now
        ):
            due.append(row.task_id)
    return due


def _resolve_inventory(
    session: Session,
    *,
    project: str,
    task_source: ProjectTaskSourceDB,
    selection_type: str,
    task_paths: list[str] | None,
    grep: str | None,
) -> list[ProjectTaskInventoryDB]:
    """Resolve a schedule selection against the task inventory.

    Mirrors :func:`agent_task_runner._resolve_inventory_rows` but kept
    local to avoid an import cycle (``agent_task_runner`` imports back
    into this module lazily for the post-batch update hook).
    """
    statement = select(ProjectTaskInventoryDB).where(
        ProjectTaskInventoryDB.project == project,
        ProjectTaskInventoryDB.task_source_id == task_source.id,
    )
    all_rows = list(session.exec(statement).all())

    if grep:
        needle = grep.lower()
        all_rows = [
            row
            for row in all_rows
            if needle in row.task_id.lower()
            or needle in row.display_name.lower()
            or needle in row.folder_path.lower()
        ]

    if selection_type == "all":
        return all_rows

    if selection_type in ("task", "tasks"):
        if not task_paths:
            return []
        wanted = set(task_paths)
        return [
            row
            for row in all_rows
            if row.task_id in wanted or row.task_path in wanted
        ]

    if selection_type == "folder":
        if not task_paths:
            return []
        folders = list(task_paths)
        return [
            row
            for row in all_rows
            if any(
                row.folder_path.startswith(folder)
                or row.task_path.startswith(folder)
                for folder in folders
            )
        ]

    return []


def update_adaptive_state_after_batch(
    session: Session,
    schedule: AgentTaskScheduleDB,
    batch: AgentTaskBatchRunDB,
) -> None:
    """Update per-task adaptive state after a batch completes.

    For each task run in the batch, apply the SM-2 update using the run's
    pass/fail result, then recompute the schedule's ``next_run_at`` as the
    earliest next-run across all task states.
    """
    now = datetime.now(timezone.utc)
    task_runs = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
    ).all()

    for task_run in task_runs:
        passed = task_run.status == "passed"
        state = _get_or_create_state(
            session,
            schedule_id=schedule.id,
            task_id=task_run.task_id,
            task_path=task_run.task_path,
        )
        new_interval, new_ease, new_consecutive = compute_adaptive_next_run(
            current_interval_days=state.current_interval_days,
            ease_factor=state.ease_factor,
            consecutive_passes=state.consecutive_passes,
            passed=passed,
            min_interval_days=schedule.min_interval_days,
            max_interval_days=schedule.max_interval_days,
        )
        state.current_interval_days = new_interval
        state.ease_factor = new_ease
        state.consecutive_passes = new_consecutive
        state.last_run_at = now
        state.last_status = task_run.status
        state.task_path = task_run.task_path
        state.next_run_at = compute_adaptive_next_run_at(
            interval_days=new_interval,
            base_hour=schedule.hour,
            base_timezone=schedule.timezone,
            from_time=now,
        )
        session.add(state)

    schedule.next_run_at = recompute_schedule_next_run(
        session, schedule, fallback_from_time=now
    )
    schedule.last_triggered_at = now
    session.add(schedule)
    session.commit()


def recompute_schedule_next_run(
    session: Session,
    schedule: AgentTaskScheduleDB,
    *,
    fallback_from_time: datetime | None = None,
) -> datetime:
    """Return the earliest next-run across all task states.

    Falls back to ``min_interval_days`` from ``fallback_from_time`` when no
    states exist (e.g. empty selection or pre-first-run).
    """
    states = session.exec(
        select(AdaptiveTaskStateDB).where(
            AdaptiveTaskStateDB.schedule_id == schedule.id
        )
    ).all()
    upcoming = [
        s.next_run_at if s.next_run_at.tzinfo is not None
        else s.next_run_at.replace(tzinfo=timezone.utc)
        for s in states
        if s.next_run_at is not None
    ]
    if upcoming:
        return min(upcoming)

    return compute_adaptive_next_run_at(
        interval_days=schedule.min_interval_days,
        base_hour=schedule.hour,
        base_timezone=schedule.timezone,
        from_time=fallback_from_time,
    )


def _get_or_create_state(
    session: Session,
    *,
    schedule_id: str,
    task_id: str,
    task_path: str,
) -> AdaptiveTaskStateDB:
    state_id = f"{schedule_id}||{task_id}"
    state = session.get(AdaptiveTaskStateDB, state_id)
    if state is not None:
        return state
    state = AdaptiveTaskStateDB(
        id=state_id,
        schedule_id=schedule_id,
        task_id=task_id,
        task_path=task_path,
    )
    session.add(state)
    session.flush()
    return state


def _ensure_utc(dt: datetime) -> datetime:
    """Re-attach UTC tzinfo if SQLite stripped it on read-back."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _selection_task_paths(
    selection_query: dict[str, object] | None,
) -> list[str] | None:
    if not selection_query:
        return None
    raw = selection_query.get("task_paths")
    if not isinstance(raw, list):
        return None
    raw_items: list[object] = raw
    return [item for item in raw_items if isinstance(item, str)]


def _get_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone: {name}") from exc
