"""Server-Sent Events (SSE) endpoint for trace streaming.

Provides a streaming endpoint that clients connect to for receiving
live trace events: trace:created, span:created, span:updated, trace:completed.
"""

# pyright: reportCallIssue=false, reportCallInDefaultInitializer=false, reportDeprecated=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

from datetime import datetime
from typing import cast

from fastapi import APIRouter, Depends, Request
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, col, select

from ..db import get_session
from ..db_helpers import _as_column
from ..models.db import LoggedCallDB, RunDB
from ..services.sse import format_sse_event, sse_streaming_response
from ..services.trace_broadcaster import get_trace_broadcaster

router = APIRouter(prefix="/v1/traces", tags=["Trace Streaming"])


LOGGED_CALL_CREATED_AT_COL: ColumnElement[datetime] = _as_column(
    cast(object, LoggedCallDB.created_at)
)


@router.get("/{trace_id}/stream")
async def stream_trace_events(
    trace_id: str,
    request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Subscribe to real-time events for a trace.

    SSE endpoint that pushes trace events as they happen.
    Clients receive instant updates without polling.

    **Event Types:**
    - `trace:created` - Trace (run) was created
    - `span:created` - New span (logged call) added to trace
    - `span:updated` - Span was updated (e.g., ended)
    - `trace:completed` - Trace was completed

    **Connection Lifecycle:**
    - Sends current trace state immediately upon connection
    - Stays open streaming live events
    - Auto-closes when trace is completed
    - Client disconnects are detected and cleaned up

    Args:
        trace_id: Run ID to subscribe to (same as run_id)
        request: FastAPI request for detecting disconnects
        session: Database session for fetching current state

    Returns:
        StreamingResponse with SSE content type
    """
    broadcaster = await get_trace_broadcaster()

    initial_events = _build_initial_events(trace_id, project, session)

    return sse_streaming_response(
        request,
        lambda: broadcaster.subscribe(trace_id),
        initial_events,
        log_label=f"TraceSSE {trace_id}",
    )


def _build_initial_events(trace_id: str, project: str, session: Session) -> list[str]:
    """Build initial SSE events from current trace state.

    Sends existing trace data so the client has immediate context
    before live events start streaming. Scoped by ``(trace_id, project)``
    so two Projects sharing an OTel id stream only their own trace.
    """
    events: list[str] = []

    run = session.exec(
        select(RunDB).where(RunDB.id == trace_id, RunDB.project == project)
    ).first()
    if run:
        run_data: dict[str, object] = {
            "id": run.id,
            "project": run.project,
            "task_id": run.task_id,
            "flow_name": run.flow_name,
            "version": run.version,
            "status": "completed" if run.completed_at else "running",
            "call_count": run.call_count,
            "created_at": run.created_at.isoformat() if run.created_at else None,
            "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        }
        events.append(_format_sse("trace:created", trace_id, run_data))

        calls = session.exec(
            select(LoggedCallDB)
            .where(
                LoggedCallDB.run_id == trace_id,
                col(LoggedCallDB.project) == project,
            )
            .order_by(LOGGED_CALL_CREATED_AT_COL)
        ).all()

        for call in calls:
            span_data: dict[str, object] = {
                "id": call.id,
                "name": call.step_name,
                "observation_type": call.observation_type,
                "model": call.model,
                "parent_call_id": call.parent_call_id,
                "status": "completed" if call.end_time else "running",
                "latency_ms": call.latency_ms,
                "created_at": call.created_at.isoformat() if call.created_at else None,
            }
            event_type = "span:updated" if call.end_time else "span:created"
            events.append(_format_sse(event_type, trace_id, span_data))

        if run.completed_at:
            events.append(
                _format_sse(
                    "trace:completed",
                    trace_id,
                    {"duration_ms": run.duration_ms, "call_count": run.call_count},
                )
            )

    return events


def _format_sse(event_type: str, trace_id: str, data: dict[str, object]) -> str:
    """Format an SSE event string."""
    return format_sse_event(event_type, data, ("trace_id", trace_id))
