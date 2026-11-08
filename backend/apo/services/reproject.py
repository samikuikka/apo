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
transaction takes SQLite's write lock up front and commits in bounded chunks,
so concurrent OTLP ingestion interleaves instead of failing the reproject.
"""

from __future__ import annotations

import logging

from sqlmodel import Session, select, text

from ..db import begin_immediate, engine
from ..models.db import OtlpSpanDB
from .trace_ingestion_queue import PROJECTION_COMMIT_CHUNK
from .trace_projector import get_trace_projector

logger = logging.getLogger(__name__)


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

    This is idempotent — reprojecting an already-projected trace updates the
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

    with Session(engine) as session:
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

        seen = 0
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
            seen += 1
            # Chunked commits bound how long reproject holds SQLite's single
            # write lock, and the re-take keeps the next chunk's reads
            # protected. Lock exhaustion surfaces HERE and propagates: the
            # caller (per-trace admin worker) decides retry vs failure.
            if seen % PROJECTION_COMMIT_CHUNK == 0:
                session.commit()
                begin_immediate(session)

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

    with Session(engine) as session:
        # Same live-backend race as reproject_trace: per-span reads then
        # writes, so take the write lock before the first read here too.
        begin_immediate(session)
        spans = session.exec(
            select(OtlpSpanDB)
            .where(OtlpSpanDB.project_id == project_id)
            .order_by(text("id"))
            .limit(limit)
        ).all()

        seen = 0
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
            seen += 1
            # Chunked commits bound how long reproject holds SQLite's single
            # write lock, and the re-take keeps the next chunk's reads
            # protected. Lock exhaustion surfaces HERE and propagates: the
            # caller (per-trace admin worker) decides retry vs failure.
            if seen % PROJECTION_COMMIT_CHUNK == 0:
                session.commit()
                begin_immediate(session)

        session.commit()

    logger.info("Reprojected %d span(s) for project %s", count, project_id)
    return count
