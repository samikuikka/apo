# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportExplicitAny=false, reportPrivateUsage=false

from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import and_, func, or_
from sqlmodel import Session, select

from ...db import get_session
from ...models import RunDB
from ...models.columns import (
    LOGGED_CALL_LEVEL_COL,
    LOGGED_CALL_MODEL_COL,
    LOGGED_CALL_PROVIDER_COL,
    LOGGED_CALL_ROUTE_COL,
    LOGGED_CALL_RUN_ID_COL,
    RUN_CALL_COUNT_COL,
    RUN_ENVIRONMENT_COL,
    RUN_ID_COL,
    RUN_PRIMARY_MODEL_COL,
    RUN_PROJECT_COL,
    RUN_SESSION_ID_COL,
    RUN_USER_ID_COL,
    RUN_METRIC_NAME_COL,
    RUN_METRIC_RUN_ID_COL,
)
from ...models.schemas import FacetBucket, RunFacets
from ...services.filters import apply_date_range, apply_tag_filters, split_csv_param
from ...services.project_memberships import (
    enforce_project_read_from_request,
    list_readable_projects_from_request,
)

router = APIRouter(prefix="/v1/runs", tags=["runs"])


def _build_filtered_run_ids(
    session: Session,
    project: str | None = None,
    models: str | None = None,
    environment: str | None = None,
    tags: str | None = None,
    status: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    metric_name: str | None = None,
    created_after: str | None = None,
    created_before: str | None = None,
    allowed_projects: list[str] | None = None,
) -> list[str]:
    stmt = select(RUN_ID_COL)
    if project:
        stmt = stmt.where(RunDB.project == project)
    elif allowed_projects is not None:
        # No single project selected: restrict the aggregate to the caller's
        # projects so facet counts can't span tenants. A caller who is a member
        # of nothing sees no runs.
        stmt = stmt.where(RUN_PROJECT_COL.in_(allowed_projects))

    model_list = split_csv_param(models)
    if model_list:
        call_model_ids = select(LOGGED_CALL_RUN_ID_COL).where(
            LOGGED_CALL_RUN_ID_COL.is_not(None),
            LOGGED_CALL_MODEL_COL.in_(model_list),
        )
        stmt = stmt.where(
            or_(
                RUN_PRIMARY_MODEL_COL.in_(model_list),
                RUN_ID_COL.in_(call_model_ids),
            )
        )

    env_list = split_csv_param(environment)
    if env_list:
        stmt = stmt.where(RUN_ENVIRONMENT_COL.in_(env_list))

    user_list = split_csv_param(user_id)
    if user_list:
        stmt = stmt.where(RUN_USER_ID_COL.in_(user_list))

    session_list = split_csv_param(session_id)
    if session_list:
        stmt = stmt.where(RUN_SESSION_ID_COL.in_(session_list))

    if tags:
        stmt = apply_tag_filters(stmt, tags)
    if metric_name:
        metric_run_ids = select(RUN_METRIC_RUN_ID_COL).where(
            RUN_METRIC_NAME_COL == metric_name
        )
        stmt = stmt.where(RUN_ID_COL.in_(metric_run_ids))
    if created_after or created_before:
        stmt = apply_date_range(stmt, RunDB.created_at, created_after, created_before)

    status_values = split_csv_param(status)
    if status_values:
        conditions: list[Any] = []
        if "error" in status_values:
            error_sub = select(LOGGED_CALL_RUN_ID_COL).where(
                LOGGED_CALL_RUN_ID_COL.is_not(None),
                LOGGED_CALL_LEVEL_COL == "ERROR",
            )
            conditions.append(RUN_ID_COL.in_(error_sub))
        if "warning" in status_values:
            warning_sub = select(LOGGED_CALL_RUN_ID_COL).where(
                LOGGED_CALL_RUN_ID_COL.is_not(None),
                LOGGED_CALL_LEVEL_COL == "WARNING",
            )
            error_sub = select(LOGGED_CALL_RUN_ID_COL).where(
                LOGGED_CALL_RUN_ID_COL.is_not(None),
                LOGGED_CALL_LEVEL_COL == "ERROR",
            )
            conditions.append(
                and_(RUN_ID_COL.in_(warning_sub), RUN_ID_COL.not_in(error_sub))
            )
        if "success" in status_values:
            issues_sub = select(LOGGED_CALL_RUN_ID_COL).where(
                LOGGED_CALL_RUN_ID_COL.is_not(None),
                LOGGED_CALL_LEVEL_COL.in_(["ERROR", "WARNING"]),
            )
            conditions.append(
                and_(RUN_ID_COL.not_in(issues_sub), RUN_CALL_COUNT_COL > 0)
            )
        if conditions:
            stmt = stmt.where(or_(*conditions))

    return cast(list[str], session.exec(stmt).all())


def _compute_model_facets(session: Session, run_ids: list[str]) -> list[FacetBucket]:
    if not run_ids:
        return []
    stmt = (
        select(LOGGED_CALL_MODEL_COL, func.count(func.distinct(LOGGED_CALL_RUN_ID_COL)))
        .where(LOGGED_CALL_RUN_ID_COL.in_(run_ids))
        .group_by(LOGGED_CALL_MODEL_COL)
        .order_by(func.count(func.distinct(LOGGED_CALL_RUN_ID_COL)).desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


def _compute_provider_facets(session: Session, run_ids: list[str]) -> list[FacetBucket]:
    """Serving-host facet over the labels the UI displays (issue #307).

    The label is route-wins — the same projection as the runs list column
    (``provider_labels``) — so every facet bucket is a value the user can
    see in the Host column. Listing raw provider values alongside would
    offer "fireworks" for a run whose cell shows "priority": picking it
    would look like a filter that does nothing.
    """
    if not run_ids:
        return []
    label = func.coalesce(func.nullif(LOGGED_CALL_ROUTE_COL, ""),
                          func.nullif(LOGGED_CALL_PROVIDER_COL, ""))
    stmt = (
        select(label, func.count(func.distinct(LOGGED_CALL_RUN_ID_COL)))
        .where(
            LOGGED_CALL_RUN_ID_COL.in_(run_ids),
            label.is_not(None),
        )
        .group_by(label)
    )
    counts: dict[str, int] = {}
    for value, count in session.exec(stmt).all():
        if value:
            counts[str(value)] = counts.get(str(value), 0) + int(count)
    return [
        FacetBucket(value=value, count=counts[value])
        for value in sorted(counts, key=lambda v: (-counts[v], v))
    ]


def _compute_environment_facets(
    session: Session, run_ids: list[str]
) -> list[FacetBucket]:
    if not run_ids:
        return []
    stmt = (
        select(RunDB.environment, func.count())
        .where(RUN_ID_COL.in_(run_ids))
        .group_by(RunDB.environment)
        .order_by(func.count().desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows]


def _compute_tag_facets(session: Session, run_ids: list[str]) -> list[FacetBucket]:
    if not run_ids:
        return []
    conn: Any = session.connection().connection.connection
    placeholders = ",".join("?" for _ in run_ids)
    query_str = (
        "SELECT jt.value, COUNT(DISTINCT runs.id) as cnt "
        + "FROM runs, json_each(runs.tags) jt "
        + f"WHERE runs.id IN ({placeholders}) "
        + "GROUP BY jt.value ORDER BY cnt DESC"
    )
    results = conn.execute(query_str, list(run_ids)).fetchall()
    return [FacetBucket(value=str(r[0]), count=int(r[1])) for r in results]


def _compute_user_facets(session: Session, run_ids: list[str]) -> list[FacetBucket]:
    if not run_ids:
        return []
    stmt = (
        select(RunDB.user_id, func.count())
        .where(RUN_ID_COL.in_(run_ids))
        .where(RunDB.user_id != None)  # noqa: E711
        .where(RunDB.user_id != "")
        .group_by(RunDB.user_id)
        .order_by(func.count().desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


def _compute_session_facets(
    session: Session, run_ids: list[str]
) -> list[FacetBucket]:
    if not run_ids:
        return []
    stmt = (
        select(RunDB.session_id, func.count())
        .where(RUN_ID_COL.in_(run_ids))
        .where(RunDB.session_id != None)  # noqa: E711
        .where(RunDB.session_id != "")
        .group_by(RunDB.session_id)
        .order_by(func.count().desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


def _compute_score_facets(session: Session, run_ids: list[str]) -> list[FacetBucket]:
    if not run_ids:
        return []
    stmt = (
        select(RUN_METRIC_NAME_COL, func.count(func.distinct(RUN_METRIC_RUN_ID_COL)))
        .where(RUN_METRIC_RUN_ID_COL.in_(run_ids))
        .group_by(RUN_METRIC_NAME_COL)
        .order_by(func.count(func.distinct(RUN_METRIC_RUN_ID_COL)).desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


def _compute_status_facets(session: Session, run_ids: list[str]) -> list[FacetBucket]:
    if not run_ids:
        return [
            FacetBucket(value="success", count=0),
            FacetBucket(value="warning", count=0),
            FacetBucket(value="error", count=0),
        ]

    error_ids = set(
        session.exec(
            select(LOGGED_CALL_RUN_ID_COL).where(
                LOGGED_CALL_RUN_ID_COL.in_(run_ids),
                LOGGED_CALL_LEVEL_COL == "ERROR",
            )
        ).all()
    )
    warning_ids = set(
        session.exec(
            select(LOGGED_CALL_RUN_ID_COL).where(
                LOGGED_CALL_RUN_ID_COL.in_(run_ids),
                LOGGED_CALL_LEVEL_COL == "WARNING",
            )
        ).all()
    )
    runs_with_calls = set(
        session.exec(
            select(RUN_ID_COL).where(
                RUN_ID_COL.in_(run_ids),
                RunDB.call_count > 0,
            )
        ).all()
    )

    error_count = len(error_ids)
    warning_count = len(warning_ids - error_ids)
    success_count = len(runs_with_calls - error_ids - warning_ids)

    return [
        FacetBucket(value="success", count=success_count),
        FacetBucket(value="warning", count=warning_count),
        FacetBucket(value="error", count=error_count),
    ]


@router.get("/facets")
def get_run_facets(
    http_request: Request,
    project: str | None = None,
    models: str | None = Query(None, description="Comma-separated model list"),
    environment: str | None = Query(None, description="Comma-separated environment list"),
    tags: str | None = Query(None, description="Comma-separated tag list"),
    status: str | None = Query(None, description="Comma-separated status list"),
    user_id: str | None = Query(None, description="Comma-separated user ID list"),
    session_id: str | None = Query(
        None, description="Comma-separated session ID list"
    ),
    metric_name: str | None = Query(None, description="Score metric name"),
    created_after: str | None = None,
    created_before: str | None = None,
    session: Session = Depends(get_session),
) -> RunFacets:
    """Pre-computed facet counts for filter sidebar."""
    # Same tenancy scoping as the other trace reads: enforce membership for a
    # selected project, otherwise restrict the aggregate to the caller's
    # projects (dev/open mode stays unscoped via allowed_projects=None).
    allowed_projects: list[str] | None = None
    if project:
        _ = enforce_project_read_from_request(http_request, session, project)
    else:
        allowed_projects = list_readable_projects_from_request(
            http_request, session
        )

    all_kwargs: dict[str, Any] = dict(
        project=project,
        models=models,
        environment=environment,
        tags=tags,
        status=status,
        user_id=user_id,
        session_id=session_id,
        metric_name=metric_name,
        created_after=created_after,
        created_before=created_before,
        allowed_projects=allowed_projects,
    )

    def filtered_ids(**overrides: Any) -> list[str]:
        kw = {**all_kwargs, **overrides}
        return _build_filtered_run_ids(session=session, **kw)

    return RunFacets(
        status=_compute_status_facets(
            session, filtered_ids(status=None) if status else filtered_ids()
        ),
        models=_compute_model_facets(
            session, filtered_ids(models=None) if models else filtered_ids()
        ),
        providers=_compute_provider_facets(session, filtered_ids()),
        environments=_compute_environment_facets(
            session,
            filtered_ids(environment=None) if environment else filtered_ids(),
        ),
        tags=_compute_tag_facets(
            session, filtered_ids(tags=None) if tags else filtered_ids()
        ),
        users=_compute_user_facets(
            session, filtered_ids(user_id=None) if user_id else filtered_ids()
        ),
        sessions=_compute_session_facets(
            session,
            filtered_ids(session_id=None) if session_id else filtered_ids(),
        ),
        scores=_compute_score_facets(
            session,
            filtered_ids(metric_name=None) if metric_name else filtered_ids(),
        ),
    )


@router.get("/facets/span-fields")
def get_span_field_facets(
    http_request: Request,
    project: str = Query(..., description="Project to facet over"),
    created_after: str | None = Query(None, description="ISO 8601 datetime (spans' start-time clock)"),
    created_before: str | None = Query(None, description="ISO 8601 datetime (spans' start-time clock)"),
    window: str = Query("7d", description="Default window when no dates given: e.g. '7d'; 'all' disables"),
    span_text: str | None = Query(None, description="Narrows facet counts like the run list's span_text"),
    limit: int = Query(50, ge=1, le=100),
    session: Session = Depends(get_session),
) -> dict[str, list[FacetBucket]]:
    """Span-derived facet buckets (services, operations) for the filter bar.

    Counts are per distinct trace within the project + window (the spans'
    start_time clock — the run list filters on runs.created_at, so counts
    can differ slightly at window edges). A default 7-day window guards
    the page-load scan; ``window=all`` opts out explicitly.
    """
    from datetime import datetime, timedelta, timezone
    import re as _re

    from ...services.trace_search import span_field_facets

    # Same tenancy scoping as every other trace read.
    _ = enforce_project_read_from_request(http_request, session, project)

    after: datetime | None = None
    before: datetime | None = None
    for raw, label in ((created_after, "created_after"), (created_before, "created_before")):
        if raw is None:
            continue
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"invalid {label}: {raw}") from exc
        if label == "created_after":
            after = parsed
        else:
            before = parsed

    if after is None and before is None:
        match = _re.fullmatch(r"(\d+)d", window)
        if window == "all":
            pass
        elif match:
            after = datetime.now(timezone.utc) - timedelta(days=int(match.group(1)))
        else:
            raise HTTPException(status_code=400, detail="window must be '<N>d' or 'all'")

    result = span_field_facets(
        session,
        project=project,
        created_after=after,
        created_before=before,
        span_text=span_text,
        limit=limit,
    )
    return {
        "services": [FacetBucket(value=b["value"], count=b["count"]) for b in result["services"]],
        "operations": [
            FacetBucket(value=b["value"], count=b["count"]) for b in result["operations"]
        ],
    }
