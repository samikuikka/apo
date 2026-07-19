"""In-memory event broadcaster for trace streaming via SSE.

Thin wrapper around the generic Broadcaster that adds trace-specific event
types and convenience methods. The SSE plumbing (queues, locks, listener
management, disconnect cleanup) lives once in Broadcaster.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from .broadcaster import Broadcaster
from .sse import format_sse_event


class TraceEvent:
    """Represents a single trace streaming event.

    Attributes:
        event_type: Type of trace event
        trace_id: ID of the trace (run_id)
        data: Event-specific payload
        timestamp: When the event occurred (UTC)
    """

    def __init__(
        self,
        event_type: str,
        trace_id: str,
        data: dict[str, object],
        timestamp: datetime | None = None,
    ):
        self.event_type: str = event_type
        self.trace_id: str = trace_id
        self.data: dict[str, object] = data
        self.timestamp: datetime = timestamp or datetime.now(timezone.utc)

    def to_sse_format(self) -> str:
        """Convert event to SSE format string."""
        return format_sse_event(
            self.event_type,
            self.data,
            ("trace_id", self.trace_id),
            self.timestamp,
        )


class TraceBroadcaster:
    """Broadcasts trace events to connected SSE clients.

    Wraps a generic Broadcaster[str], delegating subscribe/publish/cleanup
    to it and adding only trace-event formatting and convenience methods.
    """

    def __init__(self) -> None:
        self._inner: Broadcaster[str] = Broadcaster()

    def subscribe(self, trace_id: str) -> AsyncIterator[str]:
        """Subscribe to SSE events for a specific trace.

        Yields pre-formatted SSE message strings. Automatically cleaned up
        on disconnect.
        """
        return self._inner.subscribe(trace_id)

    async def publish(self, trace_id: str, event: TraceEvent) -> None:
        """Publish a trace event to all subscribers of a trace."""
        await self._inner.publish(trace_id, event.to_sse_format())

    async def broadcast_trace_created(self, trace_id: str, data: dict[str, object]) -> None:
        """Broadcast a trace:created event."""
        await self.publish(trace_id, TraceEvent("trace:created", trace_id, data))

    async def broadcast_span_created(self, trace_id: str, data: dict[str, object]) -> None:
        """Broadcast a span:created event."""
        await self.publish(trace_id, TraceEvent("span:created", trace_id, data))

    async def broadcast_span_updated(self, trace_id: str, data: dict[str, object]) -> None:
        """Broadcast a span:updated event."""
        await self.publish(trace_id, TraceEvent("span:updated", trace_id, data))

    async def broadcast_trace_completed(self, trace_id: str, data: dict[str, object]) -> None:
        """Broadcast a trace:completed event."""
        await self.publish(trace_id, TraceEvent("trace:completed", trace_id, data))

    async def get_listener_count(self, trace_id: str) -> int:
        """Get the number of active listeners for a trace."""
        return await self._inner.get_listener_count(trace_id)

    async def close_all(self) -> None:
        """Close all listener connections."""
        await self._inner.close_all()


_broadcaster: TraceBroadcaster | None = None
_broadcaster_lock = asyncio.Lock()


async def get_trace_broadcaster() -> TraceBroadcaster:
    """Get the global TraceBroadcaster singleton."""
    global _broadcaster

    if _broadcaster is None:
        async with _broadcaster_lock:
            if _broadcaster is None:
                _broadcaster = TraceBroadcaster()

    return _broadcaster


def reset_trace_broadcaster() -> None:
    """Reset the global broadcaster instance (for testing)."""
    global _broadcaster
    _broadcaster = None
