# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""SPEC-136 ticket 12: re-pricing service.

Inline streamed-batch reprice. For each computed-provenance call with
``raw_usage``, recompute cost against ``call.start_time`` + current tiers via
the same ``compute_cost`` used at ingestion, overwriting ``cost`` /
``cost_breakdown`` / tier fields in place (unless ``dry_run``).

Skip rules (reported in the summary, never silently dropped):
  - provided-cost calls: SDK cost is authoritative (skipped)
  - pre-migration calls (no ``raw_usage``): nothing to reprice (skipped)
  - no matching model-era at ``call.start_time``: stays unpriced (skipped)

Mirrors ``services/reproject.py``'s shape (inline, scoped, per-row try/except).
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlmodel import Session, col, select

from ..models.db import LoggedCallDB
from .pricing.compute import compute_cost

logger = logging.getLogger(__name__)


def reprice_calls(
    session: Session,
    *,
    project: str | None = None,
    model_id: int | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    dry_run: bool = False,
    batch_size: int = 1000,
) -> dict[str, int]:
    """Reprice computed-provenance calls in place; return a summary.

    Filters (AND-combined, all optional): ``project`` (call.project),
    ``model_id`` (call.internal_model_id), ``since``/``until`` (half-open
    [since, until) on call.created_at). ``dry_run`` recomputes without writing.
    """
    del batch_size  # streamed in one pass; SQLite-in-process has no win batching

    stmt = select(LoggedCallDB).where(LoggedCallDB.cost_provenance == "computed")
    if project is not None:
        stmt = stmt.where(LoggedCallDB.project == project)
    if model_id is not None:
        stmt = stmt.where(LoggedCallDB.internal_model_id == model_id)
    if since is not None:
        stmt = stmt.where(LoggedCallDB.created_at >= since)
    if until is not None:
        stmt = stmt.where(LoggedCallDB.created_at < until)

    calls = list(session.exec(stmt).all())

    repriced = 0
    skipped_provided = 0
    skipped_no_usage = 0
    skipped_no_match = 0
    net_delta = 0

    for call in calls:
        try:
            old_cost = call.cost or 0
            result = compute_cost(
                session,
                call.model,
                call.raw_usage or {},
                call.project,
                call.created_at or datetime.now(),
            )
            if result is None:
                skipped_no_match += 1
                continue

            new_cost = result.total
            net_delta += new_cost - old_cost

            if not dry_run:
                call.cost = new_cost
                call.cost_breakdown = result.breakdown or None
                call.internal_model_id = result.model_id
                call.matched_tier_id = result.tier_id
                call.matched_tier_name = result.tier_name
                session.add(call)
            repriced += 1
        except Exception:
            logger.warning("reprice failed for call %s; skipping", call.id, exc_info=True)
            skipped_no_match += 1

    # Also account for provided/pre-migration calls in scope (reported, skipped).
    # NOTE: SQL three-valued logic excludes NULL from `!=`, so NULL-provenance
    # (pre-migration) calls need an explicit IS NULL clause.
    skip_stmt = select(LoggedCallDB).where(
        (col(LoggedCallDB.cost_provenance) != "computed")
        | col(LoggedCallDB.cost_provenance).is_(None)
    )
    if project is not None:
        skip_stmt = skip_stmt.where(LoggedCallDB.project == project)
    if model_id is not None:
        skip_stmt = skip_stmt.where(LoggedCallDB.internal_model_id == model_id)
    if since is not None:
        skip_stmt = skip_stmt.where(LoggedCallDB.created_at >= since)
    if until is not None:
        skip_stmt = skip_stmt.where(LoggedCallDB.created_at < until)
    for call in session.exec(skip_stmt).all():
        if call.cost_provenance == "provided":
            skipped_provided += 1
        elif call.raw_usage is None:
            skipped_no_usage += 1

    if not dry_run:
        session.commit()

    return {
        "repriced": repriced,
        "skipped_provided": skipped_provided,
        "skipped_no_usage": skipped_no_usage,
        "skipped_no_match": skipped_no_match,
        "net_delta": net_delta,
    }


__all__ = ["reprice_calls"]
