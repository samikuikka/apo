"""Generic in-memory pub/sub broadcaster using asyncio.Queue.

Provides a type-parameterized Broadcaster[K] that manages SSE-style
event streaming to multiple listeners per key. Thread-safe through
asyncio.Lock and non-blocking on slow consumers: each subscriber's queue is
bounded (by event count and by buffered bytes), and a subscriber that falls
behind loses its oldest queued events, never the publisher's time or the
server's memory.

For single-instance deployments. Replace with Redis pub/sub for multi-instance.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Generic, TypeVar, final

from .sse_limits import load_sse_limits

_logger = logging.getLogger(__name__)

K = TypeVar("K")


@final
class _Subscriber:
    """One listener: its bounded queue and what that queue holds.

    ``queued_bytes`` counts characters. That equals on-wire bytes for the
    ASCII JSON frames ``format_sse_event`` produces, and an approximation is
    all a bound needs for anything else.
    """

    __slots__ = ("queue", "queued_bytes", "reported_dropping")

    def __init__(self, queue: asyncio.Queue[str | None]) -> None:
        self.queue: asyncio.Queue[str | None] = queue
        self.queued_bytes: int = 0
        self.reported_dropping: bool = False


class Broadcaster(Generic[K]):
    """Broadcasts string messages to all subscribers of a given key.

    Each key maps to a set of subscribers, each with its own bounded queue.
    Subscribers consume messages via the async generator returned by
    subscribe(). Publishing never blocks or raises: a subscriber whose queue
    is full (by event count or by bytes) has its oldest messages dropped to
    make room, so it always holds the newest ones.
    """

    def __init__(
        self,
        *,
        max_queue_events: int | None = None,
        max_queue_bytes: int | None = None,
    ) -> None:
        if max_queue_events is None or max_queue_bytes is None:
            limits = load_sse_limits()
            if max_queue_events is None:
                max_queue_events = limits.queue_max_events
            if max_queue_bytes is None:
                max_queue_bytes = limits.queue_max_bytes
        self._max_queue_events: int = max_queue_events
        self._max_queue_bytes: int = max_queue_bytes
        self._listeners: dict[K, set[_Subscriber]] = {}
        self._lock: asyncio.Lock = asyncio.Lock()

    async def subscribe(self, key: K) -> AsyncIterator[str]:
        """Subscribe to events for a specific key.

        Creates a queue for this subscriber and yields messages as they arrive.
        Automatically cleaned up on disconnect (None sentinel or generator exit).
        """
        subscriber = _Subscriber(asyncio.Queue(maxsize=self._max_queue_events))

        async with self._lock:
            if key not in self._listeners:
                self._listeners[key] = set()
            self._listeners[key].add(subscriber)

        try:
            while True:
                event = await subscriber.queue.get()
                if event is None:
                    break
                subscriber.queued_bytes -= len(event)
                yield event
        finally:
            await self._remove_listener(key, subscriber)

    async def publish(self, key: K, message: str) -> None:
        """Publish a pre-formatted SSE message to all subscribers of a key."""
        async with self._lock:
            listeners = self._listeners.get(key, set()).copy()

        for subscriber in listeners:
            self._offer(key, subscriber, message)

    async def _remove_listener(self, key: K, subscriber: _Subscriber) -> None:
        async with self._lock:
            if key in self._listeners:
                self._listeners[key].discard(subscriber)
                if not self._listeners[key]:
                    del self._listeners[key]

    async def get_listener_count(self, key: K) -> int:
        async with self._lock:
            return len(self._listeners.get(key, set()))

    async def close_all(self) -> None:
        """Close all listener connections by sending None sentinel."""
        async with self._lock:
            for key, listeners in self._listeners.items():
                for subscriber in listeners:
                    self._offer(key, subscriber, None)
            self._listeners.clear()

    def _offer(self, key: K, subscriber: _Subscriber, message: str | None) -> None:
        """Enqueue for one subscriber without blocking, dropping its oldest
        messages to make room.

        Two budgets, either can bind: buffered bytes (a single legacy event
        can carry a whole call body) and event count (the queue's maxsize,
        via the QueueFull branch). A message bigger than the whole byte
        budget is still enqueued once the queue is empty: a subscriber that
        is keeping up must not lose it. The close sentinel (``None``, size
        zero) never triggers the byte budget but still displaces the oldest
        message on a full queue, so closing always lands.
        """
        size = len(message) if message is not None else 0
        queue = subscriber.queue
        while (
            size
            and subscriber.queued_bytes + size > self._max_queue_bytes
            and not queue.empty()
        ):
            self._drop_oldest(key, subscriber)
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            self._drop_oldest(key, subscriber)
            queue.put_nowait(message)
        subscriber.queued_bytes += size

    def _drop_oldest(self, key: K, subscriber: _Subscriber) -> None:
        dropped = subscriber.queue.get_nowait()
        if dropped is not None:
            subscriber.queued_bytes -= len(dropped)
        if not subscriber.reported_dropping:
            # Once per subscriber: a caller that never reads its streams must
            # not be able to fill the log one warning at a time.
            subscriber.reported_dropping = True
            _logger.warning(
                "SSE subscriber on %r is falling behind; dropping its oldest events",
                key,
            )
