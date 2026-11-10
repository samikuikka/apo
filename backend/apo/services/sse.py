"""Shared SSE plumbing for real-time event streams.

Single source of truth for the SSE envelope format and the streaming
response shape used by all SSE endpoints (trace streaming, run events).

Every SSE stream in the system yields pre-formatted ``text/event-stream``
frames. The envelope is always ``{event_type, data, timestamp}`` plus one
routing field that identifies which stream the event belongs to
(``trace_id`` for trace streaming, ``project`` for run events). Building
that envelope in four places drifted three slightly different copies;
this module owns it once.

Because every stream is built here, this is also where the number of
streams one caller may hold open is capped: a stream takes one of its
caller's slots when it is built and gives it back when it ends.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import weakref
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timezone

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from .sse_limits import get_stream_limiter
from .telemetry_admission import derive_admission_identity

_logger = logging.getLogger(__name__)

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

# How long a stream may stay silent before a comment frame is written.
# Intermediaries (Cloudflare's proxy, tunnels, LBs) close connections that
# send no bytes for ~100 seconds, which silently kills every quiet SSE
# stream mid-run: a task run emits nothing between its started and
# completed events, so without keepalives the browser's EventSource is
# dead by the time the terminal event fires. Kept well under the lowest
# common idle timeout.
KEEPALIVE_INTERVAL_SECONDS = 25.0

# SSE comment frame: ignored by EventSource, but keeps bytes flowing.
KEEPALIVE_FRAME = ": keepalive\n\n"


class StreamCapExceeded(HTTPException):
    """429 for a caller that already holds its maximum number of open streams.

    The standard rate-limit response shape: a ``detail`` message plus the
    ``Retry-After`` and ``X-RateLimit-*`` headers the other limiters send.
    """

    def __init__(self, limit: int) -> None:
        super().__init__(
            status_code=429,
            detail="Concurrent stream limit exceeded",
            headers={
                "Retry-After": str(_STREAM_CAP_RETRY_AFTER_SECONDS),
                "X-RateLimit-Limit": str(limit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Resource": "streams",
                "X-RateLimit-Scope": "identity",
            },
        )


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
    keepalive_interval: float = KEEPALIVE_INTERVAL_SECONDS,
) -> StreamingResponse:
    """Build the standard SSE StreamingResponse.

    Yields ``initial_events`` first, then streams live events from
    ``subscribe()`` (a zero-arg factory returning an async iterator of
    pre-formatted SSE strings). While the subscription is quiet, writes a
    comment frame every ``keepalive_interval`` seconds so idle-timeout
    intermediaries don't drop the connection. Checks for client disconnect
    between each yield. Uses the shared SSE headers and
    ``text/event-stream`` media type.

    Each stream takes one of its caller's concurrent stream slots
    (``APO_MAX_STREAMS_PER_IDENTITY``, same identity as every other
    limiter) and holds it until the stream ends. Raises
    :class:`StreamCapExceeded` (a 429) when the caller holds them all.
    """
    limiter = get_stream_limiter()
    lease = limiter.try_acquire(_stream_identity(request))
    if lease is None:
        raise StreamCapExceeded(limiter.max_streams_per_identity)

    initial = list(initial_events)

    async def event_stream() -> AsyncIterator[str]:
        iterator = subscribe().__aiter__()
        # The pending __anext__ is awaited with a timeout via asyncio.wait
        # (which never cancels on timeout) rather than asyncio.wait_for
        # (which would cancel the generator frame and tear down the
        # subscription on the first quiet interval).
        next_event: asyncio.Task[str] | None = None
        try:
            for evt in initial:
                if await request.is_disconnected():
                    return
                yield evt
            while True:
                if next_event is None:
                    next_event = asyncio.ensure_future(iterator.__anext__())
                done, _ = await asyncio.wait(
                    {next_event}, timeout=keepalive_interval
                )
                if not done:
                    if await request.is_disconnected():
                        break
                    yield KEEPALIVE_FRAME
                    continue
                try:
                    event = next_event.result()
                except StopAsyncIteration:
                    next_event = None
                    break
                next_event = None
                if await request.is_disconnected():
                    break
                yield event
        except Exception:
            _logger.debug("%s stream closed", log_label, exc_info=True)
        finally:
            # First and without awaiting anything: the awaits below can
            # themselves be cancelled on teardown, and the slot must come
            # back however this stream ends.
            lease.release()
            if next_event is not None:
                if not next_event.done():
                    _ = next_event.cancel()
                try:
                    await next_event
                except (asyncio.CancelledError, StopAsyncIteration):
                    pass
                except Exception:
                    _logger.debug(
                        "%s pending subscription closed with an error",
                        log_label,
                        exc_info=True,
                    )
            aclose = getattr(iterator, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:
                    _logger.debug(
                        "%s subscription close failed", log_label, exc_info=True
                    )

    stream = event_stream()
    # A stream that is never iterated (its client vanished before the body
    # started) never runs its own finally; the slot comes back when the
    # generator is collected instead. Tied to the generator and not to the
    # response: the generator's lifetime is the stream's, while a response
    # object can be dropped by anything that keeps only its body iterator.
    _ = weakref.finalize(stream, lease.release)
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


def _stream_identity(request: Request) -> str:
    """The caller a stream is counted against.

    The same identity every other limiter derives, so one caller is one
    bucket everywhere: a user, an API key, or a token subject. Anonymous
    demo and open-development traffic share the ``open-dev`` bucket (the
    demo is one tenant), and an authenticated caller whose subject cannot
    be derived shares one bucket too rather than going uncounted.
    """
    identity = derive_admission_identity(request.state)
    return identity if identity is not None else _UNIDENTIFIED_STREAM_IDENTITY


# A slot held by a connection that already dropped is reclaimed when the
# stream next checks for a disconnect, at the latest one keepalive interval
# later, so by then a retry finds any slot that was only stale.
_STREAM_CAP_RETRY_AFTER_SECONDS = math.ceil(KEEPALIVE_INTERVAL_SECONDS)

# Fallback bucket for an authenticated caller whose subject could not be
# derived: counted as one shared tenant instead of uncounted.
_UNIDENTIFIED_STREAM_IDENTITY = "unidentified"
