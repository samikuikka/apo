"""Route ``apo.score`` sentinel spans to the scoring service.

A score is a product-domain record, not a telemetry call. The sentinel
span's attributes carry the score fields. This module isolates that
transitional convention — ADR-0001 calls ``apo.score`` "transitional and
will be retired after a native score API path" — so the projector stays
free of score plumbing and the convention has one home.

Routing is idempotent by ``(run_id/call_id, metric_name)``: re-projecting
the same sentinel is a no-op if the metric already exists.
"""

from __future__ import annotations

import logging

from sqlmodel import Session

from ..models.db import CallMetricDB, OtlpSpanDB, RunMetricDB
from .projection_lookup import select_call_metric, select_run_metric

logger = logging.getLogger(__name__)


def route_score_span(session: Session, span: OtlpSpanDB) -> None:
    """Route an ``apo.score`` sentinel span to the scoring service.

    Idempotent by ``(run_id/call_id, metric_name)`` — re-projecting the same
    sentinel is a no-op if the metric already exists.
    """
    from .scoring import record_score

    attrs = span.attributes or {}
    name = str(attrs.get("apo.score.name") or attrs.get("score.name") or "")
    if not name:
        logger.warning("Score span %s has no apo.score.name; skipping", span.span_id)
        return

    raw_value: float | str | bool | None
    raw = attrs.get("apo.score.value")
    if raw is None:
        raw = attrs.get("score.value")
    if isinstance(raw, (int, float, str, bool)):
        raw_value = raw
    else:
        raw_value = None
    data_type = str(attrs.get("apo.score.data_type") or attrs.get("score.data_type") or "NUMERIC")
    source = str(attrs.get("apo.score.source") or attrs.get("score.source") or "API")
    observation_id = attrs.get("apo.score.observation_id") or attrs.get("score.observation_id")
    comment = attrs.get("apo.score.comment") or attrs.get("score.comment")

    target: tuple[str, str]
    if isinstance(observation_id, str) and observation_id:
        target = ("observation", observation_id)
    else:
        target = ("trace", span.trace_id)

    # Idempotency: skip if a quality metric with this name already exists.
    existing = _find_existing_score(session, target, name, span.project_id)
    if existing is not None:
        return

    try:
        _recorded = record_score(
            session,
            target=target,
            name=name,
            value=raw_value,
            data_type=data_type,
            source=source,
            comment=str(comment) if comment else None,
            project=span.project_id,
        )
        del _recorded  # record_score persists via session; return value unused
    except Exception:
        logger.warning("Score routing failed for span %s", span.span_id, exc_info=True)
        logger.warning("Score routing failed for span %s", span.span_id, exc_info=True)


def _find_existing_score(
    session: Session, target: tuple[str, str], name: str, project: str
) -> RunMetricDB | CallMetricDB | None:
    """Check whether a quality metric already exists (idempotency for scores)."""
    kind, target_id = target
    if kind == "trace":
        return select_run_metric(session, target_id, project, name, "quality")
    return select_call_metric(session, target_id, project, name, "quality")
