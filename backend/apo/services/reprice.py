# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""SPEC-136 ticket 12: re-pricing service.

Inline streamed-batch reprice. For each computed-provenance call with
``raw_usage``, recompute cost against ``call.start_time`` + current tiers via
the same ``compute_cost`` used at ingestion, overwriting ``cost`` /
``cost_breakdown`` / tier fields in place (unless ``dry_run``).

Skip rules (reported in the summary, never silently dropped):
  - provided-cost calls: SDK cost is authoritative (skipped)
  - computed calls with no ``raw_usage`` (pre-migration or partial): nothing to
    reprice (skipped, reported as no_usage)
  - no matching model-era at ``call.start_time``: stays unpriced (skipped)

After per-call reprice, affected run/session/task-run rollups are recomputed so
aggregate totals stay coherent (the spec requires this).

Mirrors ``services/reproject.py``'s shape (inline, scoped, per-row try/except).
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlmodel import Session, col, select

from ..metrics.aggregate import calculate_and_store_aggregate_metrics
from ..models.db import LoggedCallDB, RunMetricDB
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
) -> dict[str, int | list[str]]:
    """Reprice computed-provenance calls in place; return a summary.

    Filters (AND-combined, all optional): ``project`` (call.project),
    ``model_id`` (call.internal_model_id), ``since``/``until`` (half-open
    [since, until) on call.created_at). ``dry_run`` recomputes without writing.

    Returns ``{repriced, skipped_provided, skipped_no_usage, skipped_no_match,
    net_delta, refreshed_runs}``.
    """
    affected_runs: set[tuple[str, str]] = set()  # (run_id, project)

    repriced = 0
    skipped_provided = 0
    skipped_no_usage = 0
    skipped_no_match = 0
    net_delta = 0

    # Stream in batches (keyset pagination by row_id) so large histories don't
    # materialize entirely in memory and each batch commits independently for
    # better crash recovery.
    cursor = 0
    while True:
        stmt = (
            select(LoggedCallDB)
            .where(LoggedCallDB.cost_provenance == "computed", LoggedCallDB.row_id > cursor)
            .order_by(col(LoggedCallDB.row_id).asc())
            .limit(batch_size)
        )
        if project is not None:
            stmt = stmt.where(LoggedCallDB.project == project)
        if model_id is not None:
            stmt = stmt.where(LoggedCallDB.internal_model_id == model_id)
        if since is not None:
            stmt = stmt.where(LoggedCallDB.created_at >= since)
        if until is not None:
            stmt = stmt.where(LoggedCallDB.created_at < until)

        batch = list(session.exec(stmt).all())
        if not batch:
            break
        cursor = batch[-1].row_id or 0

        for call in batch:
            # A computed call with no raw_usage has nothing to reprice (pre-
            # migration or a partial patch). Skip + report — do NOT recompute to
            # zero (that would silently destroy a previously-frozen cost).
            if not call.raw_usage:
                skipped_no_usage += 1
                continue
            try:
                old_cost = call.cost or 0
                result = compute_cost(
                    session,
                    call.model,
                    call.raw_usage,
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
                    if call.run_id:
                        affected_runs.add((call.run_id, call.project))
                repriced += 1
            except Exception:
                logger.warning("reprice failed for call %s; skipping", call.id, exc_info=True)
                skipped_no_match += 1

        if not dry_run:
            session.commit()

    # Account for provided/pre-migration calls in scope (reported, skipped).
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
        elif not call.raw_usage:
            skipped_no_usage += 1

    # Refresh run-level aggregate rollups so totals stay coherent with the
    # repriced call costs (the spec requires this).
    refreshed: list[str] = []
    if not dry_run and affected_runs:
        for run_id, run_project in affected_runs:
            try:
                _refresh_run_aggregates(session, run_id, run_project)
                refreshed.append(run_id)
            except Exception:
                logger.warning("rollup refresh failed for run %s", run_id, exc_info=True)
        session.commit()

    return {
        "repriced": repriced,
        "skipped_provided": skipped_provided,
        "skipped_no_usage": skipped_no_usage,
        "skipped_no_match": skipped_no_match,
        "net_delta": net_delta,
        "refreshed_runs": refreshed,
    }


def _refresh_run_aggregates(session: Session, run_id: str, project: str) -> None:
    """Recompute the total_cost / avg_latency / total_tokens metrics for one run.

    Deletes the stale ``RunMetricDB`` aggregate rows and re-stores them from the
    current call set (mirrors ``trace_projector._compute_run_aggregates``).
    """
    # Drop stale aggregate metrics for this run.
    stale = session.exec(
        select(RunMetricDB).where(
            RunMetricDB.run_id == run_id,
            RunMetricDB.project == project,
            RunMetricDB.metric_type == "aggregate",
        )
    ).all()
    for m in stale:
        session.delete(m)

    new_metrics = calculate_and_store_aggregate_metrics(session, run_id, project)
    for metric in new_metrics:
        session.add(metric)


__all__ = ["reprice_calls"]
