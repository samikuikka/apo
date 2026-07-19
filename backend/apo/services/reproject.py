"""Re-project canonical OTel spans into product tables (SPEC-129 Criterion #2).

The replay capability proves the canonical store (``OtlpSpanDB``) is the source
of truth: after a mapper change, you can re-project all spans for a trace through
the updated normalizer without re-ingesting the raw OTLP payload.

Usage::

    from apo.services.reproject import reproject_trace
    count = reproject_trace(trace_id, project_id="my-project")

This reads canonical spans from ``OtlpSpanDB``, runs each through the normalizer
and projector (which upserts into ``RunDB`` / ``LoggedCallDB``), and returns the
number of spans projected.
"""

from __future__ import annotations

import logging

from sqlmodel import Session, select, text

from ..db import engine
from ..models.db import OtlpSpanDB
from .trace_projector import get_trace_projector

logger = logging.getLogger(__name__)


def reproject_trace(trace_id: str, project_id: str) -> int:
    """Re-project all canonical spans for a trace through the normalizer + projector.

    Args:
        trace_id: The OTel trace ID to reproject.
        project_id: The project the trace belongs to (for project isolation).

    Returns:
        The number of spans projected.

    This is idempotent — reprojecting an already-projected trace updates the
    existing ``LoggedCallDB`` rows rather than duplicating them. If the
    canonical span attributes have changed (e.g. after a mapper update), the
    new values are reflected in the projection.

    Note: reproject does NOT re-claim task-run ownership. The claim was
    established during original ingestion and is immutable (SPEC-128).
    Reprojecting updates the projection tables but preserves the existing
    ``RunDB.task_run_id`` linkage.
    """
    projector = get_trace_projector()
    count = 0

    with Session(engine) as session:
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

        for span in spans:
            try:
                projector.project(span, session)
                count += 1
            except Exception:
                logger.warning(
                    "Reprojection failed for span %s (canonical kept)",
                    span.span_id,
                    exc_info=True,
                )

        session.commit()

    logger.info("Reprojected %d span(s) for trace %s", count, trace_id)
    return count


def reproject_project(project_id: str, limit: int = 1000) -> int:
    """Re-project all canonical spans for a project.

    Useful after a global mapper change. Processes traces in batches to avoid
    loading everything into memory at once.

    Args:
        project_id: The project to reproject.
        limit: Maximum number of spans to process (safety valve).

    Returns:
        The number of spans projected.
    """
    projector = get_trace_projector()
    count = 0

    with Session(engine) as session:
        spans = session.exec(
            select(OtlpSpanDB)
            .where(OtlpSpanDB.project_id == project_id)
            .order_by(text("id"))
            .limit(limit)
        ).all()

        for span in spans:
            try:
                projector.project(span, session)
                count += 1
            except Exception:
                logger.warning(
                    "Reprojection failed for span %s",
                    span.span_id,
                    exc_info=True,
                )
                session.rollback()

        session.commit()

    logger.info("Reprojected %d span(s) for project %s", count, project_id)
    return count
