"""Re-project canonical OTel spans into product tables.

The replay capability proves the canonical store (``OtlpSpanDB``) is the source
of truth: after a mapper change, you can re-project all spans for a trace through
the updated normalizer without re-ingesting the raw OTLP payload.

Usage::

    from apo.services.reproject import reproject_trace
    count = reproject_trace(trace_id, project_id="my-project")

This reads canonical spans from ``OtlpSpanDB``, runs each through the normalizer
and projector (which upserts into ``RunDB`` / ``LoggedCallDB``), and returns the
number of spans projected. Safe to run against a live backend: every
transaction takes SQLite's write lock up front, is bounded in spans and in
time, and is followed by a pause with the lock released, so concurrent OTLP
ingestion and every other writer interleave even when reprojections run back
to back. Run rollups are recomputed once per run at the end of the pass, not
once per span.
"""

from __future__ import annotations

import logging
import time

from sqlmodel import Session, select, text

from ..db import begin_immediate, engine
from ..models.db import OtlpSpanDB
from .trace_ingestion_queue import PROJECTION_COMMIT_CHUNK
from .trace_projector import (
    deferred_run_aggregates,
    flush_run_aggregates,
    get_trace_projector,
)

logger = logging.getLogger(__name__)

# Longest one reproject transaction holds SQLite's write lock before it
# commits, whatever its span count: a chunk of spans with large payloads must
# not hold the lock for as long as 32 of them take.
REPROJECT_CHUNK_BUDGET_SECONDS = 0.25
# How long the write lock stays free between two reproject transactions.
# Committing and retaking it at once leaves a gap too short for a waiting
# writer to notice, so a client looping reproject requests could hold the
# lock for as long as it liked while every other writer ran into
# busy_timeout. SQLite's busy handler polls at most every 100 ms, so each
# pause this long gives a waiting writer an even chance or better; over the
# chunks of even one large trace it cannot stay locked out.
REPROJECT_CHUNK_PAUSE_SECONDS = 0.05


def reproject_trace(
    trace_id: str, project_id: str, cost_mode: str = "refresh"
) -> int:
    """Re-project all canonical spans for a trace through the normalizer + projector.

    Args:
        trace_id: The OTel trace ID to reproject.
        project_id: The project the trace belongs to (for project isolation).
        cost_mode: "refresh" re-runs cost calculation; "preserve" leaves
            every stored price/cost field untouched (identity-only replay).

    Returns:
        The number of spans projected.

    This is idempotent: reprojecting an already-projected trace updates the
    existing ``LoggedCallDB`` rows rather than duplicating them. If the
    canonical span attributes have changed (e.g. after a mapper update), the
    new values are reflected in the projection.

    Note: reproject does NOT re-claim task-run ownership. The claim was
    established during original ingestion and is immutable.
    Reprojecting updates the projection tables but preserves the existing
    ``RunDB.task_run_id`` linkage.
    """
    projector = get_trace_projector()
    count = 0

    with Session(engine) as session, deferred_run_aggregates(session):
        # Reprojection runs on a live backend (admin preview-backfill while
        # OTLP ingestion projects concurrently). The projector reads run/call
        # state before each write, so take SQLite's write lock before the
        # first read (the queue-worker pattern) or a competing commit can
        # turn those writes into lock failures the per-span handler below
        # would swallow as silent under-projection.
        begin_immediate(session)
        spans = session.exec(
            select(OtlpSpanDB)
            .where(
                OtlpSpanDB.trace_id == trace_id,
                OtlpSpanDB.project_id == project_id,
            )
            .order_by(text("id"))
        ).all()

        if not spans:
            logger.info("No canonical spans found for trace %s in project %s", trace_id, project_id)
            return 0

        chunk = _ChunkBudget()
        for span in spans:
            try:
                projector.project(span, session, cost_mode=cost_mode)
                count += 1
            except Exception:
                logger.warning(
                    "Reprojection failed for span %s (canonical kept)",
                    span.span_id,
                    exc_info=True,
                )
            if chunk.spent():
                chunk = _yield_write_lock(session)

        _ = flush_run_aggregates(session)
        session.commit()

    logger.info("Reprojected %d span(s) for trace %s", count, trace_id)
    return count


def reproject_project(
    project_id: str, limit: int = 1000, cost_mode: str = "refresh"
) -> int:
    """Re-project all canonical spans for a project.

    Useful after a global mapper change. Processes traces in batches to avoid
    loading everything into memory at once.

    Args:
        project_id: The project to reproject.
        limit: Maximum number of spans to process (safety valve).
        cost_mode: "refresh" re-runs cost calculation; "preserve" leaves
            every stored price/cost field untouched (identity-only replay).

    Returns:
        The number of spans projected.
    """
    projector = get_trace_projector()
    count = 0

    with Session(engine) as session, deferred_run_aggregates(session):
        # Same live-backend race as reproject_trace: per-span reads then
        # writes, so take the write lock before the first read here too.
        begin_immediate(session)
        spans = session.exec(
            select(OtlpSpanDB)
            .where(OtlpSpanDB.project_id == project_id)
            .order_by(text("id"))
            .limit(limit)
        ).all()

        chunk = _ChunkBudget()
        for span in spans:
            try:
                projector.project(span, session, cost_mode=cost_mode)
                count += 1
            except Exception:
                logger.warning(
                    "Reprojection failed for span %s",
                    span.span_id,
                    exc_info=True,
                )
                session.rollback()
                # The rollback also released the write lock; re-take it so
                # one bad span cannot reopen the snapshot hazard for the
                # rest of the chunk.
                begin_immediate(session)
            if chunk.spent():
                chunk = _yield_write_lock(session)

        _ = flush_run_aggregates(session)
        session.commit()

    logger.info("Reprojected %d span(s) for project %s", count, project_id)
    return count


class _ChunkBudget:
    """What one reproject transaction may do before it gives up the lock."""

    def __init__(self) -> None:
        self._spans: int = 0
        self._started: float = time.monotonic()

    def spent(self) -> bool:
        """Count one projected span; True once the transaction must end."""
        self._spans += 1
        return (
            self._spans >= PROJECTION_COMMIT_CHUNK
            or time.monotonic() - self._started >= REPROJECT_CHUNK_BUDGET_SECONDS
        )


def _yield_write_lock(session: Session) -> _ChunkBudget:
    """End the chunk, leave the write lock free for a moment, take it again.

    Chunked commits bound how long reproject holds SQLite's single write
    lock, and the re-take keeps the next chunk's reads protected. Lock
    exhaustion surfaces HERE and propagates: the caller (per-trace admin
    worker, or the HTTP client) decides retry vs failure.
    """
    session.commit()
    _pause_between_chunks()
    begin_immediate(session)
    return _ChunkBudget()


def _pause_between_chunks() -> None:
    """Wait with the write lock released so a queued writer can take it."""
    time.sleep(REPROJECT_CHUNK_PAUSE_SECONDS)
