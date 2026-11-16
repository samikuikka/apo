"""How projection passes share SQLite's single write lock.

A pass (the queue worker projecting an ingest batch, or reproject) writes
for its whole life, so it holds the write lock from its first read. It
works in chunks: each chunk is one transaction bounded in spans and in
time, and is followed by a pause with the lock released. Passes also take
turns among themselves in this process, one chunk each, so at any moment
at most one of them is waiting in SQLite's busy handler.

Both halves are needed for heartbeats, result submissions, OTLP accepts
and every other writer to interleave. SQLite hands the lock to whichever
waiter polls first after a release, not to the one that waited longest:
without the pause a pass retakes the lock before any waiter polls, and
without the turns every concurrent pass is one more waiter the others
have to beat, so a writer's wait grows with the number of batches being
projected at once.
"""

from __future__ import annotations

import threading
import time
from types import TracebackType

from sqlmodel import Session

from ..db import SQLITE_BUSY_TIMEOUT_MS, begin_immediate

# Spans projected between commits. Chunked commits bound how long one
# projection pass holds SQLite's single write lock, so concurrent writers
# interleave instead of starving behind a whole 2048-span batch.
PROJECTION_COMMIT_CHUNK = 32
# Longest one projection transaction holds the write lock before it commits,
# whatever its span count: a chunk of spans with large payloads must not
# hold the lock for as long as 32 of them take.
PROJECTION_CHUNK_BUDGET_SECONDS = 0.25
# Longest the write lock stays free after a projection transaction. A full
# chunk pauses this long, a shorter one in proportion to how long it held
# the lock, so a pass leaves the lock free for about a sixth of its time
# and a one-span batch does not pay a full chunk's pause.
# Committing and retaking the lock at once leaves a gap too short for a
# waiting writer to notice, so passes running back to back could hold the
# lock for as long as there was work while every other writer ran into
# busy_timeout. SQLite's busy handler polls at most every 100 ms and each
# poll finds the lock free that fraction of the time, so a waiting writer
# gets in within a few polls.
PROJECTION_CHUNK_PAUSE_SECONDS = 0.05
# A pass that cannot get its turn for this long stops waiting and competes
# for the write lock directly, where busy_timeout bounds it as before: the
# turn spreads the lock fairly, it must never park a claimed batch past
# its lease.
PROJECTION_TURN_TIMEOUT_SECONDS = SQLITE_BUSY_TIMEOUT_MS / 1000

_projection_turn = threading.Lock()


class ProjectionPass:
    """One pass's hold on the write lock, taken and given up chunk by chunk.

    Entering takes the turn and the write lock (``BEGIN IMMEDIATE``, before
    the pass's first read). The body projects spans and calls
    ``span_done`` after each; it commits its last transaction itself.
    Lock exhaustion surfaces from ``BEGIN IMMEDIATE`` and propagates: the
    caller decides retry vs failure (the queue worker requeues the batch,
    reproject hands it to its client).
    """

    def __init__(self, session: Session) -> None:
        self._session: Session = session
        self._holds_turn: bool = False
        self._spans: int = 0
        self._started: float = 0.0

    def __enter__(self) -> ProjectionPass:
        self._begin_chunk()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        # A pass that left without committing (it failed, or found nothing
        # to do) still holds the write lock until its session closes, so a
        # pause here would be a pause inside the lock.
        if not self._session.in_transaction():
            pause_with_lock_released(self._held_seconds())
        self._release_turn()

    def span_done(self) -> None:
        """Count one projected span; end the chunk once it is over budget."""
        self._spans += 1
        if (
            self._spans >= PROJECTION_COMMIT_CHUNK
            or self._held_seconds() >= PROJECTION_CHUNK_BUDGET_SECONDS
        ):
            self._session.commit()
            pause_with_lock_released(self._held_seconds())
            self._release_turn()
            self._begin_chunk()

    def _begin_chunk(self) -> None:
        self._holds_turn = _projection_turn.acquire(
            timeout=PROJECTION_TURN_TIMEOUT_SECONDS
        )
        try:
            begin_immediate(self._session)
        except BaseException:
            self._release_turn()
            raise
        self._spans = 0
        self._started = time.monotonic()

    def _held_seconds(self) -> float:
        return time.monotonic() - self._started

    def _release_turn(self) -> None:
        if self._holds_turn:
            self._holds_turn = False
            _projection_turn.release()


def pause_with_lock_released(held_seconds: float) -> None:
    """Wait with the write lock released so a queued writer can take it."""
    share = min(held_seconds / PROJECTION_CHUNK_BUDGET_SECONDS, 1.0)
    time.sleep(PROJECTION_CHUNK_PAUSE_SECONDS * share)
