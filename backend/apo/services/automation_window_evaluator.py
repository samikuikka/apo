"""Windowed automation triggers ("monitors").

Event automations match a single run event as it happens. Window automations
step back and ask an aggregate question over recent history — "is the suite
pass rate below 80% over the last 24h?" — and fire when the answer crosses a
threshold. The evaluator is the piece that answers it:

- every ``AUTOMATION_WINDOW_EVALUATION_INTERVAL_SECONDS`` (default 5m, the
  cadence respan uses) each enabled window automation's metric is computed
  over its window from ``agent_task_batch_runs`` (+ child ``agent_task_runs``
  for cost/token sums and task/model scoping),
- a breach fires only on the **rising edge** (``was_breached``): a windowed
  threshold stays breached for many ticks, and firing every tick would be
  noise — the suite does not un-break on its own,
- delivery reuses the automations execution machinery (executions log,
  HMAC-signed webhooks, encrypted Slack/GitHub actions, health auto-disable).

Every metric here computes from stored columns only (batch counts/checks/
timestamps, task-run cost/tokens) — nothing projected on the fly, so
``reasoning_tokens`` (a projection over generation usage) is deliberately
not offered.
"""

from __future__ import annotations

# pyright: reportPrivateUsage=false, reportImplicitStringConcatenation=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

import asyncio
import logging
import math
import os
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy import exists as sa_exists
from sqlmodel import Session, col, select

from ..db import engine
from ..db_helpers import as_column
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AutomationDB,
    AutomationExecutionDB,
)
from .automations import (
    AutomationRequestError,
    _automation_snapshot,
    _execute_delivery,
    _prune_executions,
    _shared_client,
)

logger = logging.getLogger(__name__)

TRIGGER_EVENT = "event"
TRIGGER_WINDOW = "window"

WINDOW_EVENT_TYPE = "window.breached"

WINDOW_METRICS: dict[str, str] = {
    "suite_pass_rate": "Suite pass rate",
    "checks_pass_rate": "Checks pass rate",
    "failed_tasks": "Failed tasks",
    "failed_checks": "Failed checks",
    "errored_tasks": "Errored tasks",
    "error_rate": "Error rate",
    "total_cost": "Total cost",
    "avg_cost": "Average cost",
    "peak_cost": "Peak cost",
    "avg_duration_s": "Average duration",
    "peak_duration_s": "Peak duration",
    "p95_duration_s": "P95 duration",
    "total_tokens": "Total tokens",
}

WINDOW_OPERATORS = ("lt", "gt", "gte")
EVALUATION_WINDOWS = ("1h", "6h", "24h", "7d")
_WINDOW_SPANS: dict[str, timedelta] = {
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
}

# Where-filters the window query can actually apply. Event automations
# validate conditions against the event payload vocabulary; window
# automations filter the run history instead, so the implementable set is
# smaller (provider would need JSON-array containment SQL; follow-up).
WINDOW_CONDITION_FIELDS: dict[str, tuple[str, ...]] = {
    "environment": ("=",),
    "task": ("contains",),
    "model": ("=",),
    "trigger.source": ("=",),
}

_DEFAULT_EVALUATION_INTERVAL_SECONDS = 300.0


def validate_window_config(
    *,
    metric: str | None,
    operator: str | None,
    threshold: float | None,
    window: str | None,
) -> None:
    """Validate a window trigger's knobs; raises for the route to map."""
    if metric not in WINDOW_METRICS:
        raise AutomationRequestError(f"Unknown window metric: {metric!r}")
    if operator not in WINDOW_OPERATORS:
        raise AutomationRequestError(f"Unknown window operator: {operator!r}")
    if threshold is None or not math.isfinite(threshold):
        raise AutomationRequestError("window_threshold must be a number")
    if window not in EVALUATION_WINDOWS:
        raise AutomationRequestError(f"Unknown evaluation window: {window!r}")


def validate_window_conditions(
    conditions: list[dict[str, object]],
) -> None:
    """Where-filters narrow the runs the metric is computed over."""
    for condition in conditions:
        field = str(condition.get("field", ""))
        operator = str(condition.get("operator", ""))
        allowed = WINDOW_CONDITION_FIELDS.get(field)
        if allowed is None:
            raise AutomationRequestError(
                f"Window automations cannot filter on {field!r} "
                f"(supported: {', '.join(sorted(WINDOW_CONDITION_FIELDS))})"
            )
        if operator not in allowed:
            raise AutomationRequestError(
                f"Field {field!r} supports {allowed}, not {operator!r}"
            )
        if not str(condition.get("value", "")).strip():
            raise AutomationRequestError("Window conditions need a non-empty value")


def threshold_breached(
    operator: str, value: float | None, threshold: float
) -> bool:
    """A missing value (empty window) never fires — the monitor is armed."""
    if value is None:
        return False
    if operator == "lt":
        return value < threshold
    if operator == "gt":
        return value > threshold
    return value >= threshold


class _WindowData:
    """Batch runs in the window plus the per-batch cost/token sums.

    Cost and tokens live on task runs, not batch rows, so they are summed
    per batch once and cached here.
    """

    batches: list[AgentTaskBatchRunDB]

    def __init__(self, batches: list[AgentTaskBatchRunDB], session: Session) -> None:
        self.batches = batches
        self.batch_cost: dict[str, float] = {}
        self.batch_tokens: dict[str, float] = {}
        batch_ids = [b.id for b in batches if b.id]
        if not batch_ids:
            return
        rows = session.exec(
            select(
                AgentTaskRunDB.batch_run_id,
                AgentTaskRunDB.total_cost,
                AgentTaskRunDB.total_tokens,
            ).where(col(AgentTaskRunDB.batch_run_id).in_(batch_ids))
        ).all()
        for batch_run_id, cost, tokens in rows:
            assert batch_run_id is not None
            if cost is not None:
                self.batch_cost[batch_run_id] = (
                    self.batch_cost.get(batch_run_id, 0.0) + cost
                )
            if tokens is not None:
                self.batch_tokens[batch_run_id] = (
                    self.batch_tokens.get(batch_run_id, 0.0) + float(tokens)
                )

    def sum(self, getter: Callable[[AgentTaskBatchRunDB], float | None]) -> float | None:
        present = [v for v in (getter(b) for b in self.batches) if v is not None]
        return float(sum(present)) if present else None

    def durations(self) -> list[float]:
        return [
            (batch.completed_at - batch.started_at).total_seconds()
            for batch in self.batches
            if batch.started_at is not None and batch.completed_at is not None
        ]


def _window_data(
    session: Session,
    project_id: str,
    window: str,
    conditions: list[dict[str, object]],
) -> _WindowData:
    """Batch runs inside the window with where-filters applied.

    ``environment`` / ``task`` / ``model`` filter in SQL; ``trigger.source``
    reads ``run_metadata`` in Python to stay dialect-neutral.
    """
    cutoff = datetime.now(timezone.utc) - _WINDOW_SPANS[window]
    query = select(AgentTaskBatchRunDB).where(
        col(AgentTaskBatchRunDB.project) == project_id,
        as_column(AgentTaskBatchRunDB.created_at) >= cutoff,
        col(AgentTaskBatchRunDB.status).in_(("completed", "error")),
    )
    trigger_source: str | None = None
    for condition in conditions:
        field = str(condition.get("field", ""))
        value = str(condition.get("value", ""))
        if field == "environment":
            query = query.where(col(AgentTaskBatchRunDB.environment) == value)
        elif field == "task":
            query = query.where(
                sa_exists(
                    select(AgentTaskRunDB.id).where(
                        col(AgentTaskRunDB.batch_run_id)
                        == col(AgentTaskBatchRunDB.id),
                        col(AgentTaskRunDB.task_id).like(f"%{value}%"),
                    )
                )
            )
        elif field == "model":
            query = query.where(
                sa_exists(
                    select(AgentTaskRunDB.id).where(
                        col(AgentTaskRunDB.batch_run_id)
                        == col(AgentTaskBatchRunDB.id),
                        col(AgentTaskRunDB.configured_model) == value,
                    )
                )
            )
        elif field == "trigger.source":
            trigger_source = value

    batches = list(session.exec(query).all())
    if trigger_source is not None:
        batches = [
            batch
            for batch in batches
            if _batch_trigger_source(batch) == trigger_source
        ]
    return _WindowData(batches, session)


def _batch_trigger_source(batch: AgentTaskBatchRunDB) -> object | None:
    metadata = batch.run_metadata
    if not isinstance(metadata, dict):
        return None
    trigger = metadata.get("trigger")
    if not isinstance(trigger, dict):
        return None
    return trigger.get("source")


def compute_window_metric(
    session: Session,
    project_id: str,
    metric: str,
    window: str,
    conditions: list[dict[str, object]],
) -> float | None:
    """Value of ``metric`` over the window; None when no runs are in scope."""
    data = _window_data(session, project_id, window, conditions)
    if metric == "suite_pass_rate":
        tasks = data.sum(lambda b: float(b.total_tasks))
        passed = data.sum(lambda b: float(b.passed_tasks))
        if tasks:
            assert passed is not None
            return passed / tasks
        return None
    if metric == "checks_pass_rate":
        checks = data.sum(lambda b: float(b.total_checks))
        passed = data.sum(lambda b: float(b.passed_checks))
        if checks:
            assert passed is not None
            return passed / checks
        return None
    if metric == "error_rate":
        tasks = data.sum(lambda b: float(b.total_tasks))
        errored = data.sum(lambda b: float(b.errored_tasks))
        if tasks:
            assert errored is not None
            return errored / tasks
        return None
    if metric == "avg_cost":
        cost = data.sum(lambda b: data.batch_cost.get(b.id or "") or None)
        tasks = data.sum(lambda b: float(b.total_tasks))
        if cost is not None and tasks:
            return cost / tasks
        return None
    if metric == "peak_cost":
        costs = [v for v in data.batch_cost.values() if v]
        return max(costs) if costs else None
    if metric == "total_cost":
        return data.sum(lambda b: data.batch_cost.get(b.id or "") or None)
    if metric == "total_tokens":
        return data.sum(lambda b: data.batch_tokens.get(b.id or "") or None)
    if metric == "avg_duration_s":
        durations = data.durations()
        return sum(durations) / len(durations) if durations else None
    if metric == "peak_duration_s":
        durations = data.durations()
        return max(durations) if durations else None
    if metric == "p95_duration_s":
        durations = data.durations()
        if not durations:
            return None
        ordered = sorted(durations)
        index = min(len(ordered) - 1, max(0, math.ceil(0.95 * len(ordered)) - 1))
        return ordered[index]
    if metric == "failed_checks":
        return data.sum(lambda b: float(max(0, b.total_checks - b.passed_checks)))
    if metric == "failed_tasks":
        return data.sum(lambda b: float(b.failed_tasks))
    if metric == "errored_tasks":
        return data.sum(lambda b: float(b.errored_tasks))
    return None


def breach_payload(automation: AutomationDB, value: float) -> dict[str, object]:
    """Synthetic event payload for a window breach delivery.

    Mirrors run-event payload shape closely enough for the existing Slack /
    webhook renderers, with the window-specific facts front and center.
    """
    return {
        "automation_name": automation.name,
        "trigger_kind": TRIGGER_WINDOW,
        "metric": automation.window_metric,
        "metric_label": WINDOW_METRICS.get(automation.window_metric or ""),
        "value": value,
        "operator": automation.window_operator,
        "threshold": automation.window_threshold,
        "window": automation.evaluation_window,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }


async def deliver_window_test_event(
    automation: AutomationDB, session: Session
) -> tuple[bool, str | None]:
    """Deliver a synthetic window breach inline (the /test route).

    Uses the last evaluated value when there is one, else a value just past
    the threshold, so the rendered alert looks like a real breach. Skips
    health updates, like event test deliveries.
    """
    value = automation.last_evaluated_value
    threshold = automation.window_threshold
    if value is None and threshold is not None:
        value = (
            threshold * 1.1 if automation.window_operator != "lt" else threshold * 0.9
        )
    data = breach_payload(automation, value if value is not None else 0.0)
    data["__test"] = True
    assert automation.id is not None
    execution = AutomationExecutionDB(
        automation_id=automation.id,
        project_id=automation.project_id,
        event_type=WINDOW_EVENT_TYPE,
        input=data,
    )
    session.add(execution)
    session.commit()
    session.refresh(execution)
    _prune_executions(session, automation.id)
    assert execution.id is not None
    success, _, error = await _execute_delivery(
        _shared_client(),
        _automation_snapshot(automation),
        execution.id,
        automation.project_id,
        WINDOW_EVENT_TYPE,
        data,
        is_test=True,
    )
    return success, error


def evaluate_windows_once() -> list[str]:
    """One evaluation pass; returns ids of automations that fired.

    Dispatches deliveries as asyncio tasks on the running loop (the
    evaluator loop); tests can ignore them or use the async wrapper.
    """
    fired: list[str] = []
    now = datetime.now(timezone.utc)
    with Session(engine) as session:
        automations = session.exec(
            select(AutomationDB).where(
                col(AutomationDB.trigger_kind) == TRIGGER_WINDOW,
                col(AutomationDB.enabled) == True,  # noqa: E712
            )
        ).all()
        for automation in automations:
            try:
                _evaluate_one(session, automation, now, fired)
            except Exception:
                logger.exception(
                    "Window evaluation failed for automation %s", automation.id
                )
    return fired


def _evaluate_one(
    session: Session, automation: AutomationDB, now: datetime, fired: list[str]
) -> None:
    if (
        automation.window_metric is None
        or automation.window_operator is None
        or automation.window_threshold is None
        or automation.evaluation_window is None
    ):
        return
    value = compute_window_metric(
        session,
        automation.project_id,
        automation.window_metric,
        automation.evaluation_window,
        automation.conditions or [],
    )
    breached = threshold_breached(
        automation.window_operator, value, automation.window_threshold
    )
    rising = breached and not automation.was_breached
    automation.was_breached = breached
    automation.last_evaluated_at = now
    automation.last_evaluated_value = value
    session.add(automation)
    if not rising:
        session.commit()
        return

    assert value is not None
    payload = breach_payload(automation, value)
    execution = AutomationExecutionDB(
        automation_id=automation.id,
        project_id=automation.project_id,
        event_type=WINDOW_EVENT_TYPE,
        input=payload,
    )
    session.add(execution)
    session.commit()
    session.refresh(execution)
    _prune_executions(session, automation.id)
    assert automation.id is not None and execution.id is not None
    fired.append(automation.id)
    # Dispatch through the shared delivery path (semaphore, retries,
    # health). Import here to avoid a circular module dependency. Sync
    # callers (tests) have no running loop; the execution is still recorded,
    # only the delivery wait is skipped.
    from .automations import dispatch_execution_delivery

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _pending_dispatches.append(
        loop.create_task(
            dispatch_execution_delivery(
                automation.id,
                execution.id,
                automation.project_id,
                WINDOW_EVENT_TYPE,
                payload,
            )
        )
    )


_pending_dispatches: list[asyncio.Task[None]] = []


async def evaluate_windows_once_async() -> list[str]:
    """Evaluate, then await this pass's deliveries (used by the loop/tests)."""
    fired = evaluate_windows_once()
    pending, _pending_dispatches[:] = _pending_dispatches[:], []
    if pending:
        _ = await asyncio.gather(*pending)
    return fired


def _evaluation_interval_seconds() -> float:
    raw = os.environ.get("AUTOMATION_WINDOW_EVALUATION_INTERVAL_SECONDS", "")
    try:
        value = float(raw)
        return value if value > 0 else _DEFAULT_EVALUATION_INTERVAL_SECONDS
    except ValueError:
        return _DEFAULT_EVALUATION_INTERVAL_SECONDS


async def _window_evaluator_loop() -> None:
    logger.info("Window automation evaluator started")
    while not _stop_event.is_set():
        try:
            fired = await evaluate_windows_once_async()
            if fired:
                logger.info("Window automations fired: %s", ", ".join(fired))
        except Exception:
            logger.exception("Window evaluator pass failed")
        try:
            _ = await asyncio.wait_for(
                _stop_event.wait(), timeout=_evaluation_interval_seconds()
            )
        except asyncio.TimeoutError:
            pass
    logger.info("Window automation evaluator stopped")


_evaluator_task: asyncio.Task[None] | None = None
_stop_event = asyncio.Event()


def start_window_evaluator() -> None:
    global _evaluator_task, _stop_event
    if _evaluator_task is not None and not _evaluator_task.done():
        return
    _stop_event = asyncio.Event()
    _evaluator_task = asyncio.create_task(_window_evaluator_loop())


async def stop_window_evaluator() -> None:
    global _evaluator_task
    if _evaluator_task is None:
        return
    _stop_event.set()
    try:
        _ = await asyncio.wait_for(_evaluator_task, timeout=10)
    except asyncio.TimeoutError:
        _evaluator_task.cancel()
    _evaluator_task = None
