"""Run event broadcaster for SSE streaming and webhook delivery.

Fires events when batch/task runs reach terminal states.
Uses asyncio.Queue for SSE subscribers and supports cross-thread
publishing from the daemon threads that execute batch runs.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from .broadcaster import Broadcaster
from .sse import format_sse_event

logger = logging.getLogger(__name__)

EVENT_BATCH_RUN_COMPLETED = "batch_run.completed"
EVENT_BATCH_RUN_FAILED = "batch_run.failed"
EVENT_TASK_RUN_STARTED = "task_run.started"
EVENT_TASK_RUN_COMPLETED = "task_run.completed"
EVENT_TASK_RUN_ERROR = "task_run.error"
EVENT_TASK_RUN_TRACE_CLAIMED = "task_run.trace_claimed"

ALL_EVENT_TYPES = [
    EVENT_BATCH_RUN_COMPLETED,
    EVENT_BATCH_RUN_FAILED,
    EVENT_TASK_RUN_STARTED,
    EVENT_TASK_RUN_COMPLETED,
    EVENT_TASK_RUN_ERROR,
    EVENT_TASK_RUN_TRACE_CLAIMED,
]


class RunEvent:
    event_type: str
    project: str
    data: dict[str, object]
    timestamp: datetime

    def __init__(
        self,
        event_type: str,
        project: str,
        data: dict[str, object],
        timestamp: datetime | None = None,
    ):
        self.event_type = event_type
        self.project = project
        self.data = data
        self.timestamp = timestamp or datetime.now(timezone.utc)

    def to_sse_format(self) -> str:
        return format_sse_event(
            self.event_type,
            self.data,
            ("project", self.project),
            self.timestamp,
        )


class RunEventBroadcaster:
    """Broadcasts run events to connected SSE clients.

    Wraps a generic Broadcaster[str], delegating subscribe/publish/cleanup
    to it. Run-event formatting is handled by RunEvent.to_sse_format().
    """

    def __init__(self) -> None:
        self._inner: Broadcaster[str] = Broadcaster()

    def subscribe(self, project: str) -> AsyncIterator[str]:
        """Subscribe to SSE events for a specific project."""
        return self._inner.subscribe(project)

    async def publish(self, project: str, event: RunEvent) -> None:
        """Publish a run event to all subscribers of a project."""
        await self._inner.publish(project, event.to_sse_format())

    async def get_listener_count(self, project: str) -> int:
        """Get the number of active listeners for a project."""
        return await self._inner.get_listener_count(project)

    async def close_all(self) -> None:
        """Close all listener connections."""
        await self._inner.close_all()


_broadcaster: RunEventBroadcaster | None = None
_broadcaster_lock = asyncio.Lock()

_event_loop: asyncio.AbstractEventLoop | None = None


async def get_run_event_broadcaster() -> RunEventBroadcaster:
    global _broadcaster
    if _broadcaster is None:
        async with _broadcaster_lock:
            if _broadcaster is None:
                _broadcaster = RunEventBroadcaster()
    return _broadcaster


def reset_run_event_broadcaster() -> None:
    global _broadcaster
    _broadcaster = None


def set_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _event_loop
    _event_loop = loop


def _build_task_run_payload(task_run: AgentTaskRunDB) -> dict[str, object]:
    tr = task_run
    started_at = tr.started_at.isoformat() if tr.started_at else None
    completed_at = tr.completed_at.isoformat() if tr.completed_at else None
    duration_ms: float | None = None
    if tr.started_at and tr.completed_at:
        delta = (tr.completed_at - tr.started_at).total_seconds() * 1000
        duration_ms = round(delta, 1)

    total_checks = len(tr.checks_json or [])
    passed_checks = sum(
        1
        for item in (tr.checks_json or [])
        if isinstance(item, dict) and item.get("pass") is True
    )

    return {
        "task_run_id": tr.id,
        "batch_run_id": tr.batch_run_id,
        "task_id": tr.task_id,
        "status": tr.status,
        "pass_result": tr.pass_result,
        "total_checks": total_checks,
        "passed_checks": passed_checks,
        "failed_checks": max(total_checks - passed_checks, 0),
        "duration_ms": duration_ms,
        "total_cost": tr.total_cost,
        "started_at": started_at,
        "completed_at": completed_at,
        "trace_run_id": tr.trace_run_id,
    }


def _build_batch_run_payload(
    batch: AgentTaskBatchRunDB, task_runs: list[AgentTaskRunDB]
) -> dict[str, object]:
    b = batch
    started_at = b.started_at.isoformat() if b.started_at else None
    completed_at = b.completed_at.isoformat() if b.completed_at else None
    duration_ms: float | None = None
    if b.started_at and b.completed_at:
        delta = (b.completed_at - b.started_at).total_seconds() * 1000
        duration_ms = round(delta, 1)

    payload: dict[str, object] = {
        "batch_run_id": b.id,
        "status": b.status,
        "total_tasks": b.total_tasks,
        "passed_tasks": b.passed_tasks,
        "failed_tasks": b.failed_tasks,
        "errored_tasks": b.errored_tasks,
        "duration_ms": duration_ms,
        "started_at": started_at,
        "completed_at": completed_at,
        "task_run_ids": [tr.id for tr in task_runs],
    }
    if b.run_metadata:
        payload["run_metadata"] = b.run_metadata
    return payload


def emit_task_run_event(project: str, task_run: AgentTaskRunDB) -> None:
    if _event_loop is None:
        return

    if task_run.status in ("passed", "failed"):
        event_type = EVENT_TASK_RUN_COMPLETED
    elif task_run.status == "error":
        event_type = EVENT_TASK_RUN_ERROR
    elif task_run.status == "running":
        event_type = EVENT_TASK_RUN_STARTED
    else:
        return

    event = RunEvent(
        event_type=event_type,
        project=project,
        data=_build_task_run_payload(task_run),
    )

    _ = asyncio.run_coroutine_threadsafe(
        _publish_event(project, event),
        _event_loop,
    )


def emit_batch_run_event(
    project: str, batch: AgentTaskBatchRunDB, task_runs: list[AgentTaskRunDB]
) -> None:
    if _event_loop is None:
        return

    if batch.status == "completed":
        event_type = EVENT_BATCH_RUN_COMPLETED
    elif batch.status == "error":
        event_type = EVENT_BATCH_RUN_FAILED
    else:
        return

    event = RunEvent(
        event_type=event_type,
        project=project,
        data=_build_batch_run_payload(batch, task_runs),
    )

    _ = asyncio.run_coroutine_threadsafe(
        _publish_event(project, event),
        _event_loop,
    )


def emit_task_run_trace_claimed(
    project: str,
    task_run_id: str,
    trace_run_id: str,
    batch_run_id: str | None,
) -> None:
    """Notify subscribers that a task run's trace id was claimed.

    ``trace_run_id`` is populated by ingestion mid-run (not by the runner),
    so without this event the dashboard never learns which trace is live
    while a task is executing — the live-trace panel stays stuck on
    "Waiting for spans..." until the terminal ``task_run.completed`` event.
    """
    if _event_loop is None:
        return

    data: dict[str, object] = {
        "task_run_id": task_run_id,
        "trace_run_id": trace_run_id,
        "status": "running",
    }
    if batch_run_id is not None:
        data["batch_run_id"] = batch_run_id

    event = RunEvent(
        event_type=EVENT_TASK_RUN_TRACE_CLAIMED,
        project=project,
        data=data,
    )

    _ = asyncio.run_coroutine_threadsafe(
        _publish_event(project, event),
        _event_loop,
    )


async def _publish_event(project: str, event: RunEvent) -> None:
    try:
        broadcaster = await get_run_event_broadcaster()
        await broadcaster.publish(project, event)
    except Exception:
        logger.exception("Failed to publish run event")

    try:
        from .webhook_delivery import fire_webhooks_for_event

        await fire_webhooks_for_event(project, event)
    except Exception:
        logger.exception("Failed to fire webhooks for event")
