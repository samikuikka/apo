"""Project-scoped lookups for Trace Projection rows (SPEC-133 M4 / ADR-0002).

Public OTel trace/span IDs are not globally unique storage identities once two
Projects can project the same id. Every lookup of a projected ``RunDB`` /
``LoggedCallDB`` row, and every metric/score row that hangs off them, must
carry the Project. These helpers are the single place that contract lives so
new callers cannot forget the scope.

Prefer these over ``session.get(RunDB, trace_id)`` — the surrogate ``row_id``
PK makes a by-id fetch meaningless for these tables.
"""

from __future__ import annotations

from sqlmodel import Session, col, select

from ..models.db import CallMetricDB, LoggedCallDB, RunDB, RunMetricDB


def select_run(session: Session, trace_id: str, project: str) -> RunDB | None:
    """Load a projected ``RunDB`` row scoped by ``(id, project)``."""
    return session.exec(
        select(RunDB).where(RunDB.id == trace_id, col(RunDB.project) == project)
    ).first()


def select_call(session: Session, span_id: str, project: str) -> LoggedCallDB | None:
    """Load a projected ``LoggedCallDB`` row scoped by ``(id, project)``."""
    return session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.id == span_id, col(LoggedCallDB.project) == project
        )
    ).first()


def select_run_metric(
    session: Session,
    run_id: str,
    project: str,
    metric_name: str,
    metric_type: str,
) -> RunMetricDB | None:
    """Load a run-level metric scoped by ``(run_id, project, name, type)``."""
    return session.exec(
        select(RunMetricDB).where(
            RunMetricDB.run_id == run_id,
            col(RunMetricDB.project) == project,
            RunMetricDB.metric_name == metric_name,
            RunMetricDB.metric_type == metric_type,
        )
    ).first()


def select_call_metric(
    session: Session,
    call_id: str,
    project: str,
    metric_name: str,
    metric_type: str,
) -> CallMetricDB | None:
    """Load a call-level metric scoped by ``(call_id, project, name, type)``."""
    return session.exec(
        select(CallMetricDB).where(
            CallMetricDB.call_id == call_id,
            col(CallMetricDB.project) == project,
            CallMetricDB.metric_name == metric_name,
            CallMetricDB.metric_type == metric_type,
        )
    ).first()
