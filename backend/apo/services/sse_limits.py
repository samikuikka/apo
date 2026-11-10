"""Typed, startup-validated limits for SSE streams, and the stream cap.

Two bounds on what a live-stream client can cost the server:

- how much one subscriber may have buffered before it reads (an event count
  and a byte budget; past either, the broadcaster drops that subscriber's
  oldest events)
- how many streams one caller may hold open at once (``StreamLimiter``)

Same contract as the telemetry and request-body limits: there is no disable
flag, ``0`` never means unlimited. A present empty, non-integer, zero, or
negative value fails startup with a message naming the offending variable.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import final


class SseLimitError(RuntimeError):
    """Raised when an SSE limit env var has an invalid value."""


@dataclass(frozen=True)
class SseLimits:
    """Immutable bounds on SSE streams."""

    max_streams_per_identity: int
    queue_max_events: int
    queue_max_bytes: int


def load_sse_limits() -> SseLimits:
    """Load and validate SSE limits from the environment.

    Reads each variable at call time (not import time) so tests and app
    construction see current values. Raises :class:`SseLimitError` on the
    first invalid variable, naming only that variable.
    """
    fields: dict[str, int] = {}
    for env_name, attr_name, default in _LIMIT_SPECS:
        fields[attr_name] = _parse_positive_int(
            env_name, os.environ.get(env_name), default
        )
    return SseLimits(**fields)


class StreamLimiter:
    """Caps how many streams each caller holds open at once.

    Process-local and thread-safe: a stream can be opened from the event
    loop or from a threadpool route, and a slot can be released by the
    garbage collector on any thread. An identity with no open stream is
    forgotten, so memory follows open streams, not callers ever seen.
    """

    def __init__(self, max_streams_per_identity: int) -> None:
        self.max_streams_per_identity: int = max_streams_per_identity
        self._lock: threading.Lock = threading.Lock()
        self._open: dict[str, int] = {}

    def try_acquire(self, identity: str) -> StreamLease | None:
        """Take one slot for ``identity``, or ``None`` when it is at the cap."""
        with self._lock:
            held = self._open.get(identity, 0)
            if held >= self.max_streams_per_identity:
                return None
            self._open[identity] = held + 1
        return StreamLease(lambda: self._release(identity))

    def active_streams(self, identity: str) -> int:
        """How many slots ``identity`` holds right now."""
        with self._lock:
            return self._open.get(identity, 0)

    def tracked_identity_count(self) -> int:
        """Test/debug: number of identities with at least one open stream."""
        with self._lock:
            return len(self._open)

    def _release(self, identity: str) -> None:
        with self._lock:
            held = self._open.get(identity, 0) - 1
            if held > 0:
                self._open[identity] = held
            else:
                _ = self._open.pop(identity, None)


@final
class StreamLease:
    """One held stream slot. ``release`` is idempotent and thread-safe.

    A stream gives its slot back from more than one place (its own cleanup,
    and a finalizer for the stream that never started), so a second release
    must free nothing.
    """

    __slots__ = ("_release_fn", "_lock", "_released")

    def __init__(self, release_fn: Callable[[], None]) -> None:
        self._release_fn: Callable[[], None] = release_fn
        self._lock: threading.Lock = threading.Lock()
        self._released: bool = False

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._release_fn()


def get_stream_limiter() -> StreamLimiter:
    """The process-wide limiter, built from the environment on first use."""
    global _stream_limiter
    with _stream_limiter_lock:
        if _stream_limiter is None:
            _stream_limiter = StreamLimiter(
                load_sse_limits().max_streams_per_identity
            )
        return _stream_limiter


def reset_stream_limiter() -> None:
    """Forget the process-wide limiter and every slot it tracks (for testing)."""
    global _stream_limiter
    with _stream_limiter_lock:
        _stream_limiter = None


def _parse_positive_int(name: str, raw: str | None, default: int) -> int:
    """Parse a positive base-10 integer env var.

    Missing means default. Present empty, non-integer, zero, or negative
    raises :class:`SseLimitError` naming only ``name``.
    """
    if raw is None:
        return default
    raw = raw.strip()
    if raw == "":
        raise SseLimitError(f"{name} must be a positive integer (got empty)")
    try:
        value = int(raw)
    except ValueError:
        raise SseLimitError(
            f"{name} must be a positive base-10 integer (got {raw!r})"
        ) from None
    if value <= 0:
        raise SseLimitError(f"{name} must be a positive integer (got {value})")
    return value


# (env var name, attribute name, default)
_LIMIT_SPECS: tuple[tuple[str, str, int], ...] = (
    # A page holds one stream per live view, and only while something is
    # running, so ten leaves room for several live tabs per caller while
    # capping what a caller that never reads its streams can hold open.
    ("APO_MAX_STREAMS_PER_IDENTITY", "max_streams_per_identity", 10),
    # One OTLP request carries at most 2048 spans and each can publish a
    # created and an updated event, so a reader that keeps up never loses
    # part of a single batch.
    ("APO_SSE_QUEUE_MAX_EVENTS", "queue_max_events", 4096),
    # 2 MiB. Span events are a few hundred bytes, so the event count binds
    # first for them; this binds for the events that carry whole call bodies
    # and can be megabytes each, where a count alone bounds nothing.
    ("APO_SSE_QUEUE_MAX_BYTES", "queue_max_bytes", 2_097_152),
)

_stream_limiter: StreamLimiter | None = None
_stream_limiter_lock = threading.Lock()
