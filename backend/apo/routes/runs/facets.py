# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportExplicitAny=false, reportPrivateUsage=false

"""Facet counts for the traces sidebar, as SQL aggregates.

Each facet is one aggregate statement over the filtered-runs SELECT with its
own dimension's filter removed (the sidebar shows alternatives, not echoes).
The filtered runs are never materialized: a Python id list is one extra
statement per facet, stops working past SQLite's host-parameter limit on a
large project, and — because the old aggregates filtered by run id with no
project predicate — counted another project's copy of a shared trace id.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, true
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, col, select

from ...db import get_session
from ...models import RunDB
from ...models.columns import (
    LOGGED_CALL_MODEL_COL,
    LOGGED_CALL_PROVIDER_COL,
    LOGGED_CALL_ROUTE_COL,
    LOGGED_CALL_RUN_ID_COL,
    RUN_ENVIRONMENT_COL,
    RUN_ID_COL,
    RUN_METRIC_NAME_COL,
    RUN_METRIC_RUN_ID_COL,
    RUN_PROJECT_COL,
    RUN_SESSION_ID_COL,
    RUN_USER_ID_COL,
)
from ...models.schemas import FacetBucket, RunFacets
from ...services.filters import apply_date_range, apply_tag_filters, split_csv_param
from ...services.project_memberships import (
    enforce_project_read_from_request,
    list_readable_projects_from_request,
)
from .run_call_scope import (
    RunScope,
    calls_of_runs,
    metrics_of_runs,
    model_predicate,
    runs_with_metrics,
    scope_runs,
    status_conditions,
    status_predicate,
)

router = APIRouter(prefix="/v1/runs", tags=["runs"])


def _build_filtered_run_ids(
    scope: RunScope,
    *,
    models: str | None = None,
    environment: str | None = None,
    tags: str | None = None,
    status: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    metric_name: str | None = None,
    created_after: str | None = None,
    created_before: str | None = None,
) -> Any:
    """The SELECT of run ids every facet aggregates over.

    Never executed on its own: each facet embeds it as a subquery. Status
    and model filters come from ``run_call_scope`` so a facet and the runs
    list judge a run by the same project-scoped calls.
    """
    stmt = scope_runs(select(RUN_ID_COL), scope)

    model_list = split_csv_param(models)
    if model_list:
        stmt = stmt.where(model_predicate(scope, model_list))

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
        stmt = stmt.where(runs_with_metrics(scope, RUN_METRIC_NAME_COL == metric_name))
    if created_after or created_before:
        stmt = apply_date_range(stmt, RunDB.created_at, created_after, created_before)

    status_values = split_csv_param(status)
    if status_values:
        predicate = status_predicate(scope, status_values)
        if predicate is not None:
            stmt = stmt.where(predicate)

    return stmt


def _runs_of_scope(scope: RunScope, runs: Any) -> list[ColumnElement[bool]]:
    """Predicates keeping the runs rows that belong to ``runs`` SELECT."""
    conditions: list[ColumnElement[bool]] = []
    if scope.project:
        conditions.append(RUN_PROJECT_COL == scope.project)
    elif scope.allowed_projects is not None:
        conditions.append(RUN_PROJECT_COL.in_(scope.allowed_projects))
    conditions.append(RUN_ID_COL.in_(runs.with_only_columns(RUN_ID_COL)))
    return conditions


def _compute_status_facets(session: Session, runs: Any, scope: RunScope) -> list[FacetBucket]:
    """The three status buckets, counted by one conditional-sum statement.

    Status is per run, not per call: a run is ``error`` if it owns an ERROR
    call, ``warning`` if it owns a WARNING call and no ERROR call, and
    ``success`` when it has calls and owns neither. The row predicates come
    from ``status_conditions``, so the facet and the list's status filter
    cannot drift apart.
    """
    conditions = status_conditions(scope)
    error_count, warning_count, success_count = session.exec(
        select(
            func.count().filter(conditions.error),
            func.count().filter(conditions.warning),
            func.count().filter(conditions.success),
        ).where(*_runs_of_scope(scope, runs))
    ).one()
    return [
        FacetBucket(value="success", count=success_count),
        FacetBucket(value="warning", count=warning_count),
        FacetBucket(value="error", count=error_count),
    ]


def _compute_model_facets(session: Session, runs: Any, scope: RunScope) -> list[FacetBucket]:
    run_count = func.count(func.distinct(LOGGED_CALL_RUN_ID_COL))
    stmt = (
        select(LOGGED_CALL_MODEL_COL, run_count)
        .where(
            *calls_of_runs(scope, runs),
            LOGGED_CALL_MODEL_COL != "",
        )
        .group_by(LOGGED_CALL_MODEL_COL)
        .order_by(run_count.desc(), LOGGED_CALL_MODEL_COL.desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


def _compute_provider_facets(session: Session, runs: Any, scope: RunScope) -> list[FacetBucket]:
    """Serving-host facet over the labels the UI displays (issue #307).

    The label is route-wins — the same projection as the runs list column
    (``provider_labels``) — so every facet bucket is a value the user can
    see in the Host column. Listing raw provider values alongside would
    offer "fireworks" for a run whose cell shows "priority": picking it
    would look like a filter that does nothing.
    """
    label = func.coalesce(func.nullif(LOGGED_CALL_ROUTE_COL, ""),
                          func.nullif(LOGGED_CALL_PROVIDER_COL, ""))
    stmt = (
        select(label, func.count(func.distinct(LOGGED_CALL_RUN_ID_COL)))
        .where(
            *calls_of_runs(scope, runs),
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
    session: Session, runs: Any, scope: RunScope
) -> list[FacetBucket]:
    stmt = (
        select(RUN_ENVIRONMENT_COL, func.count())
        .where(*_runs_of_scope(scope, runs))
        .group_by(RUN_ENVIRONMENT_COL)
        .order_by(func.count().desc(), RUN_ENVIRONMENT_COL.desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows]


def _compute_tag_facets(session: Session, runs: Any, scope: RunScope) -> list[FacetBucket]:
    # json_each walks each run's tags in place: the join is a per-row path
    # expansion (ON true), one group per tag value, counting the distinct
    # runs that carry it.
    jt = func.json_each(col(RunDB.tags)).table_valued("value")
    run_count = func.count(func.distinct(RUN_ID_COL))
    stmt = (
        select(jt.c.value, run_count)
        .select_from(RunDB)
        .join(jt, true())
        .where(*_runs_of_scope(scope, runs))
        .group_by(jt.c.value)
        .order_by(run_count.desc(), jt.c.value.desc())
    )
    return [FacetBucket(value=str(r[0]), count=int(r[1])) for r in session.exec(stmt).all()]


def _compute_user_facets(session: Session, runs: Any, scope: RunScope) -> list[FacetBucket]:
    stmt = (
        select(RUN_USER_ID_COL, func.count())
        .where(
            *_runs_of_scope(scope, runs),
            RUN_USER_ID_COL.is_not(None),
            RUN_USER_ID_COL != "",
        )
        .group_by(RUN_USER_ID_COL)
        .order_by(func.count().desc(), RUN_USER_ID_COL.desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


def _compute_session_facets(
    session: Session, runs: Any, scope: RunScope
) -> list[FacetBucket]:
    stmt = (
        select(RUN_SESSION_ID_COL, func.count())
        .where(
            *_runs_of_scope(scope, runs),
            RUN_SESSION_ID_COL.is_not(None),
            RUN_SESSION_ID_COL != "",
        )
        .group_by(RUN_SESSION_ID_COL)
        .order_by(func.count().desc(), RUN_SESSION_ID_COL.desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


def _compute_score_facets(session: Session, runs: Any, scope: RunScope) -> list[FacetBucket]:
    run_count = func.count(func.distinct(RUN_METRIC_RUN_ID_COL))
    stmt = (
        select(RUN_METRIC_NAME_COL, run_count)
        .where(
            *metrics_of_runs(scope, runs),
            RUN_METRIC_NAME_COL != "",
        )
        .group_by(RUN_METRIC_NAME_COL)
        .order_by(run_count.desc(), RUN_METRIC_NAME_COL.desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


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
    scope = RunScope(project=project, allowed_projects=allowed_projects)

    filter_kwargs: dict[str, Any] = dict(
        models=models,
        environment=environment,
        tags=tags,
        status=status,
        user_id=user_id,
        session_id=session_id,
        metric_name=metric_name,
        created_after=created_after,
        created_before=created_before,
    )

    def filtered(**overrides: Any) -> Any:
        return _build_filtered_run_ids(scope, **{**filter_kwargs, **overrides})

    return RunFacets(
        status=_compute_status_facets(
            session, filtered(status=None) if status else filtered(), scope
        ),
        models=_compute_model_facets(
            session, filtered(models=None) if models else filtered(), scope
        ),
        providers=_compute_provider_facets(session, filtered(), scope),
        environments=_compute_environment_facets(
            session,
            filtered(environment=None) if environment else filtered(),
            scope,
        ),
        tags=_compute_tag_facets(
            session, filtered(tags=None) if tags else filtered(), scope
        ),
        users=_compute_user_facets(
            session, filtered(user_id=None) if user_id else filtered(), scope
        ),
        sessions=_compute_session_facets(
            session,
            filtered(session_id=None) if session_id else filtered(),
            scope,
        ),
        scores=_compute_score_facets(
            session,
            filtered(metric_name=None) if metric_name else filtered(),
            scope,
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
