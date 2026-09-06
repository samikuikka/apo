# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportDeprecated=false, reportImplicitStringConcatenation=false

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlmodel import Session

from ...db import get_session
from ...models.schemas import PaginatedSessionSummary, SessionSummary
from ...services.project_memberships import (
    enforce_project_read_from_request,
    list_readable_projects_from_request,
)

router = APIRouter(prefix="/v1/runs", tags=["runs"])


@router.get("/sessions")
def list_sessions(
    http_request: Request,
    project: str | None = None,
    page: int = Query(0, ge=0),
    page_size: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_session),
) -> PaginatedSessionSummary:
    """List sessions with aggregated trace counts and metrics."""
    conditions: list[str] = []
    # The same predicates against logged_calls (aliased ``l``) so the calls
    # subquery below narrows to the caller's projects instead of aggregating
    # the whole installation on every page view.
    call_conditions: list[str] = []
    params: dict[str, object] = {}

    if project:
        _ = enforce_project_read_from_request(http_request, session, project)
        conditions.append("r.project = :project")
        call_conditions.append("l.project = :project")
        params["project"] = project
    else:
        # No project would aggregate sessions across every tenant; scope to the
        # caller's projects (dev/open mode, no user_id, stays unscoped).
        allowed = list_readable_projects_from_request(http_request, session)
        if allowed is not None:
            if allowed:
                placeholders = ", ".join(f":p{i}" for i in range(len(allowed)))
                conditions.append(f"r.project IN ({placeholders})")
                call_conditions.append(f"l.project IN ({placeholders})")
                for i, pid in enumerate(allowed):
                    params[f"p{i}"] = pid
            else:
                # Member of nothing: return an empty page rather than everything.
                conditions.append("1 = 0")
                call_conditions.append("1 = 0")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    call_where = (
        f"WHERE {' AND '.join(call_conditions)}" if call_conditions else ""
    )

    # Count the groups the page query will actually produce. COUNT(DISTINCT
    # session_id) skips NULL, so runs with no session (reported as the "(none)"
    # group below) went uncounted — one row of data alongside total_count=0.
    count_row = session.execute(
        text(
            f"SELECT COUNT(*) FROM (SELECT r.session_id FROM runs r {where} GROUP BY r.session_id)"
        ),
        params,
    ).fetchone()
    total_count = count_row[0] if count_row else 0

    # Cost and tokens live on logged_calls, not runs. Pre-aggregate per run in a
    # subquery so the outer COUNT(*) still counts traces rather than calls; the
    # subquery carries the same project predicates so SQLite drives it off the
    # logged_calls project index rather than scanning every tenant's calls.
    offset = page * page_size
    rows = session.execute(
        text(
            "SELECT r.session_id, "
            "COUNT(*) as trace_count, "
            "MIN(r.created_at) as first_trace_at, "
            "MAX(r.created_at) as last_trace_at, "
            "COALESCE(SUM(c.run_cost), 0) as total_cost, "
            "COALESCE(SUM(c.run_tokens), 0) as total_tokens "
            "FROM runs r "
            "LEFT JOIN ("
            "  SELECT run_id, SUM(cost) as run_cost, SUM(total_tokens) as run_tokens"
            f"  FROM logged_calls l {call_where} GROUP BY run_id"
            ") c ON c.run_id = r.id "
            f"{where} "
            "GROUP BY r.session_id "
            "ORDER BY MAX(r.created_at) DESC "
            "LIMIT :limit OFFSET :offset"
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
