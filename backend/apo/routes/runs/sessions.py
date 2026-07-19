from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, text
from sqlmodel import Session, select

from ...db import get_session
from ...models import RunDB
from ...models.schemas import PaginatedSessionSummary, SessionSummary

router = APIRouter(prefix="/v1/runs", tags=["runs"])


@router.get("/sessions")
def list_sessions(
    project: str | None = None,
    page: int = Query(0, ge=0),
    page_size: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_session),
) -> PaginatedSessionSummary:
    """List sessions with aggregated trace counts and metrics."""
    conditions: list[str] = []
    params: dict[str, object] = {}

    if project:
        conditions.append("project = :project")
        params["project"] = project

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = session.execute(
        text(f"SELECT COUNT(DISTINCT session_id) FROM runs {where}"),
        params,
    ).fetchone()
    total_count = count_row[0] if count_row else 0

    offset = page * page_size
    rows = session.execute(
        text(
            f"SELECT session_id, "
            "COUNT(*) as trace_count, "
            "MIN(created_at) as first_trace_at, "
            "MAX(created_at) as last_trace_at, "
            "COALESCE(SUM(cost), 0) as total_cost, "
            "COALESCE(SUM(total_tokens), 0) as total_tokens "
            f"FROM runs {where} "
            "GROUP BY session_id "
            "ORDER BY MAX(created_at) DESC "
            f"LIMIT :limit OFFSET :offset"
        ),
        {**params, "limit": page_size, "offset": offset},
    ).fetchall()

    data = [
        SessionSummary(
            session_id=str(r[0]) if r[0] else "(none)",
            trace_count=int(r[1]),
            first_trace_at=str(r[2]) if r[2] else "",
            last_trace_at=str(r[3]) if r[3] else "",
            total_cost=float(r[4] or 0),
            total_tokens=int(r[5] or 0),
        )
        for r in rows
    ]

    total_pages = (total_count + page_size - 1) // page_size

    return PaginatedSessionSummary(
        data=data,
        total_count=total_count,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )
