"""Generic in-memory pub/sub broadcaster using asyncio.Queue.

Provides a type-parameterized Broadcaster[K] that manages SSE-style
event streaming to multiple listeners per key. Thread-safe through
asyncio.Lock and non-blocking on slow consumers (drops via QueueFull).

For single-instance deployments. Replace with Redis pub/sub for multi-instance.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Generic, TypeVar

K = TypeVar("K")


class Broadcaster(Generic[K]):
    """Broadcasts string messages to all subscribers of a given key.

    Each key maps to a set of asyncio.Queue instances (one per subscriber).
    Subscribers consume messages via the async generator returned by subscribe().
    Publishing is non-blocking: slow consumers have messages dropped (QueueFull).
    """

    def __init__(self) -> None:
        self._listeners: dict[K, set[asyncio.Queue[str | None]]] = {}
        self._lock: asyncio.Lock = asyncio.Lock()

    async def subscribe(self, key: K) -> AsyncIterator[str]:
        """Subscribe to events for a specific key.

        Creates a queue for this subscriber and yields messages as they arrive.
        Automatically cleaned up on disconnect (None sentinel or generator exit).
        """
        queue: asyncio.Queue[str | None] = asyncio.Queue()

        async with self._lock:
            if key not in self._listeners:
                self._listeners[key] = set()
            self._listeners[key].add(queue)

        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        finally:
            await self._remove_listener(key, queue)

    async def publish(self, key: K, message: str) -> None:
        """Publish a pre-formatted SSE message to all subscribers of a key."""
        async with self._lock:
            listeners = self._listeners.get(key, set()).copy()

        for queue in listeners:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pass

    async def _remove_listener(
        self, key: K, queue: asyncio.Queue[str | None]
    ) -> None:
        async with self._lock:
            if key in self._listeners:
                self._listeners[key].discard(queue)
                if not self._listeners[key]:
                    del self._listeners[key]

    async def get_listener_count(self, key: K) -> int:
        async with self._lock:
            return len(self._listeners.get(key, set()))

    async def close_all(self) -> None:
        """Close all listener connections by sending None sentinel."""
        async with self._lock:
            for listeners in self._listeners.values():
                for queue in listeners:
                    try:
                        queue.put_nowait(None)
                    except asyncio.QueueFull:
                        pass
            self._listeners.clear()
