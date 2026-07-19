"""SSE endpoint for real-time run status updates."""

from typing import cast

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import ColumnElement
from sqlmodel import Session, select

from ..db import get_session
from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from ..services.run_events import (
    EVENT_TASK_RUN_STARTED,
    EVENT_TASK_RUN_TRACE_CLAIMED,
    get_run_event_broadcaster,
)
from ..services.sse import format_sse_event, sse_streaming_response

router = APIRouter(prefix="/v1", tags=["Run Events"])


def _as_col(value: object) -> ColumnElement[str]:
    return cast(ColumnElement[str], value)


@router.get("/events")
async def stream_run_events(
    request: Request,
    project: str = Query(default="default"),
    session: Session = Depends(get_session),
):
    """Subscribe to real-time run events for a project.

    SSE endpoint that pushes events when batch/task runs reach terminal states.

    **Event Types:**
    - `batch_run.completed` - All tasks in a batch finished
    - `batch_run.failed` - Batch ended in error
    - `task_run.completed` - Individual task passed or failed
    - `task_run.error` - Individual task errored

    **Connection Lifecycle:**
    - Sends current running/pending state immediately
    - Streams live events until client disconnects
    """
    broadcaster = await get_run_event_broadcaster()
    initial_events = _build_initial_events(project, session)

    return sse_streaming_response(
        request,
        lambda: broadcaster.subscribe(project),
        initial_events,
        log_label=f"RunEvents {project}",
    )


def _build_initial_events(project: str, session: Session) -> list[str]:
    events: list[str] = []

    batches = session.exec(
        select(AgentTaskBatchRunDB)
        .where(
            AgentTaskBatchRunDB.project == project,
            _as_col(AgentTaskBatchRunDB.status).in_(["queued", "running"]),
        )
    ).all()

    for batch in batches:
        events.append(
            format_sse_event(
                "batch_run.running",
                {"batch_run_id": batch.id, "status": batch.status},
                ("project", project),
            )
        )

        # Replay the current state of each task run in the batch. Without this,
        # a client that connects after a trace was claimed mid-run (the normal
        # case — page navigation is slower than task startup) would never learn
        # the running task's trace_run_id and the live-trace panel would stay
        # stuck on "Waiting for spans..." until the terminal event.
        task_runs = session.exec(
            select(AgentTaskRunDB).where(
                AgentTaskRunDB.batch_run_id == batch.id
            )
        ).all()
        for tr in task_runs:
            if tr.status == "running":
                events.append(
                    format_sse_event(
                        EVENT_TASK_RUN_STARTED,
                        {
                            "task_run_id": tr.id,
                            "batch_run_id": tr.batch_run_id,
                            "task_id": tr.task_id,
                            "status": tr.status,
                            "trace_run_id": tr.trace_run_id,
                        },
                        ("project", project),
                    )
                )
            # A running task that has already claimed a trace needs the
            # trace_claimed replay too, so the client opens the live stream.
            if tr.status == "running" and tr.trace_run_id:
                events.append(
                    format_sse_event(
                        EVENT_TASK_RUN_TRACE_CLAIMED,
                        {
                            "task_run_id": tr.id,
                            "batch_run_id": tr.batch_run_id,
                            "trace_run_id": tr.trace_run_id,
                            "status": "running",
                        },
                        ("project", project),
                    )
                )

    return events
