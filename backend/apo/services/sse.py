"""Shared SSE plumbing for real-time event streams.

Single source of truth for the SSE envelope format and the streaming
response shape used by all SSE endpoints (trace streaming, run events).

Every SSE stream in the system yields pre-formatted ``text/event-stream``
frames. The envelope is always ``{event_type, data, timestamp}`` plus one
routing field that identifies which stream the event belongs to
(``trace_id`` for trace streaming, ``project`` for run events). Building
that envelope in four places drifted three slightly different copies;
this module owns it once.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timezone

from fastapi import Request
from fastapi.responses import StreamingResponse

_logger = logging.getLogger(__name__)

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def format_sse_event(
    event_type: str,
    data: dict[str, object],
    routing_field: tuple[str, str] | None = None,
    timestamp: datetime | None = None,
) -> str:
    """Format a single SSE event string.

    ``routing_field`` is a ``(name, value)`` pair merged into the top-level
    payload (e.g. ``("trace_id", trace_id)`` or ``("project", project)``) so
    each stream carries its own routing key without re-implementing the
    envelope.
    """
    payload: dict[str, object] = {"event_type": event_type}
    if routing_field is not None:
        name, value = routing_field
        payload[name] = value
    payload["data"] = data
    payload["timestamp"] = (timestamp or datetime.now(timezone.utc)).isoformat()
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


def sse_streaming_response(
    request: Request,
    subscribe: Callable[[], AsyncIterator[str]],
    initial_events: list[str],
    *,
    log_label: str = "SSE",
) -> StreamingResponse:
    """Build the standard SSE StreamingResponse.

    Yields ``initial_events`` first, then streams live events from
    ``subscribe()`` (a zero-arg factory returning an async iterator of
    pre-formatted SSE strings). Checks for client disconnect between each
    yield. Uses the shared SSE headers and ``text/event-stream`` media type.
    """
    initial = list(initial_events)

    async def event_stream() -> AsyncIterator[str]:
        try:
            for evt in initial:
                if await request.is_disconnected():
                    return
                yield evt
            async for event in subscribe():
                if await request.is_disconnected():
                    break
                yield event
        except Exception:
            _logger.debug("%s stream closed", log_label, exc_info=True)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
