# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryComparison=false, reportUnusedCallResult=false

"""Run-list query, hydration, and status computation.

Extracted from the ``GET /v1/runs`` handler so the filtering, pagination,
multi-query hydration, and per-run status derivation are exercisable
without going through FastAPI/HTTP. The route handler stays responsible
for parsing query params, enforcing project-scope auth, and returning
the HTTP response; everything from the ``select(RunDB)`` onward lives
here.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import asc, desc
from sqlalchemy.orm import load_only
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, col, func, or_, select

from ...db_helpers import as_column
from ...models import LoggedCallDB, RunDB, RunMetricDB, RunMetric, RunSummary
from ...services.filters import apply_date_range, apply_numeric_range, apply_tag_filters
from ...models.columns import (
    LOGGED_CALL_PROJECT_COL,
    LOGGED_CALL_PROVIDER_COL,
    LOGGED_CALL_ROUTE_COL,
    LOGGED_CALL_RUN_ID_COL,
    RUN_CREATED_AT_COL,
    RUN_DURATION_MS_COL,
    RUN_ENVIRONMENT_COL,
    RUN_EXTERNAL_ID_COL,
    RUN_FLOW_NAME_COL,
    RUN_ID_COL,
    RUN_PROJECT_COL,
    RUN_SESSION_ID_COL,
    RUN_TASK_ID_COL,
    RUN_USER_ID_COL,
    RUN_METRIC_NAME_COL,
    RUN_METRIC_SCORE_COL,
)
from ...services.projection_io import has_preview_payload
from ...services.trace_backend import parse_model_providers, provider_labels
from ...services.trace_search import apply_trace_search
from .metrics import calculate_run_metrics_from_calls
from .run_call_scope import (
    RunScope,
    calls_of_page_rows,
    metric_runs,
    metrics_of_page_rows,
    model_predicate,
    runs_with_metrics,
    scope_runs,
    status_predicate,
)


VALID_SORT_FIELDS = frozenset({"created_at", "duration_ms", "call_count"})



class PaginatedRunSummary(BaseModel):
    data: list[RunSummary]
    total_count: int
    page: int
    page_size: int
    total_pages: int


@dataclass
class RunListFilters:
    """Filter dimensions for the run list, already split from raw query strings.

    ``allowed_projects`` is the caller's membership scope (``None`` in
    dev/open mode where membership is inactive) and is applied whenever
    ``project`` is not pinned.
    """

    project: str | None = None
    flow_names: list[str] = field(default_factory=list)
    task_ids: list[str] = field(default_factory=list)
    environments: list[str] = field(default_factory=list)
    session_ids: list[str] = field(default_factory=list)
    user_ids: list[str] = field(default_factory=list)
    models: list[str] = field(default_factory=list)
    providers: list[str] = field(default_factory=list)
    tags: str | None = None
    search: str | None = None
    # Span-derived search
    service: str | None = None
    operation: str | None = None
    span_text: str | None = None
    span_predicates: list[Any] = field(default_factory=list)
    metric_name: str | None = None
    min_score: float | None = None
    max_score: float | None = None
    min_duration_ms: float | None = None
    max_duration_ms: float | None = None
    created_after: str | None = None
    created_before: str | None = None
    status_values: list[str] = field(default_factory=list)
    bookmarked: bool | None = None
    allowed_projects: list[str] | None = None
    # Run labels (``run_metadata.labels`` on the trace's parent batch):
    # ids OR within a key, AND across keys — same semantics as the run lists.
    labels: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class RunListPagination:
    page: int
    page_size: int
    sort_by: str | None
    sort_order: str | None


def list_run_summaries(
    session: Session, filters: RunListFilters, pagination: RunListPagination
) -> PaginatedRunSummary:
    # The trailing COUNT(*) OVER() rides the page query itself: the filtered
    # statement, including every span-level EXISTS, executes once instead
    # of a second full execution for the count. Window functions are
    # evaluated before OFFSET/LIMIT is applied, so the total covers the
    # whole filtered set; an empty page is zero rows and a zero total.
    scope = RunScope(project=filters.project, allowed_projects=filters.allowed_projects)
    statement = scope_runs(select(RunDB, func.count().over()), scope)
    statement = _apply_attribute_filters(statement, filters, scope)
    statement = _apply_metric_filter(statement, session, filters, scope)
    if statement is None:
        return _empty_page(pagination)
    status = status_predicate(scope, filters.status_values)
    if status is not None:
        statement = statement.where(status)
    if filters.bookmarked is not None:
        statement = statement.where(RunDB.bookmarked == filters.bookmarked)
    # Span-derived predicates MUST land before the page query executes,
    # or pages filter but counts do not.
    statement = apply_trace_search(
        statement,
        service=filters.service,
        operation=filters.operation,
        span_text=filters.span_text,
        predicates=filters.span_predicates,
    )

    statement = _apply_sort(
        statement, pagination.sort_by, pagination.sort_order
    ).offset(pagination.page * pagination.page_size).limit(pagination.page_size)

    rows = session.exec(statement).all()
    total_count = int(rows[0][1]) if rows else 0
    runs = [row[0] for row in rows]
    total_pages = (
        (total_count + pagination.page_size - 1) // pagination.page_size
        if total_count > 0
        else 0
    )

    summaries = _hydrate_summaries(session, runs, scope)
    return PaginatedRunSummary(
        data=summaries,
        total_count=total_count,
        page=pagination.page,
        page_size=pagination.page_size,
        total_pages=total_pages,
    )


def _empty_page(pagination: RunListPagination) -> PaginatedRunSummary:
    return PaginatedRunSummary(
        data=[],
        total_count=0,
        page=pagination.page,
        page_size=pagination.page_size,
        total_pages=0,
    )


def _apply_attribute_filters(
    statement: Any, filters: RunListFilters, scope: RunScope
) -> Any:
    if filters.flow_names:
        statement = statement.where(RUN_FLOW_NAME_COL.in_(filters.flow_names))
    if filters.task_ids:
        statement = statement.where(RUN_TASK_ID_COL.in_(filters.task_ids))
    if filters.environments:
        statement = statement.where(RUN_ENVIRONMENT_COL.in_(filters.environments))
    if filters.labels:
        # A trace matches a label through its task run's batch. The subquery
        # is project-correlated because trace ids may collide across projects
        # (surrogate-PK design): without the correlation, another project's
        # labelled copy of a trace would satisfy this one's label filter.
        from ...models.db import AgentTaskBatchRunDB, AgentTaskRunDB
        from ...services.run_labels import batch_scope_conditions

        matching = (
            select(AgentTaskRunDB.trace_run_id)
            .join(
                AgentTaskBatchRunDB,
                col(AgentTaskRunDB.batch_run_id) == col(AgentTaskBatchRunDB.id),
            )
            .where(
                col(AgentTaskBatchRunDB.project) == RUN_PROJECT_COL,
                col(AgentTaskRunDB.trace_run_id).is_not(None),
                *batch_scope_conditions([], filters.labels),
            )
            .correlate(RunDB)
        )
        statement = statement.where(col(RunDB.id).in_(matching))
    if filters.session_ids:
        statement = statement.where(RUN_SESSION_ID_COL.in_(filters.session_ids))
    if filters.user_ids:
        statement = statement.where(RUN_USER_ID_COL.in_(filters.user_ids))
    if filters.models:
        statement = statement.where(model_predicate(scope, filters.models))
    if filters.providers:
        # A provider filter matches the observed serving provider OR the
        # finer-grained route, so "openrouter:nitro" finds runs whose host
        # identity lives in the route attribute (issue #307). The subquery
        # is project-correlated because trace ids may collide across
        # projects (surrogate-PK design): an unscoped scan would let
        # another project's copy of a trace satisfy this one's filter.
        values = [v.lower() for v in filters.providers]
        run_project = RUN_PROJECT_COL
        call_provider_ids = (
            select(LOGGED_CALL_RUN_ID_COL)
            .where(
                LOGGED_CALL_RUN_ID_COL.is_not(None),
                LOGGED_CALL_PROJECT_COL == run_project,
                or_(
                    func.lower(LOGGED_CALL_PROVIDER_COL).in_(values),
                    func.lower(LOGGED_CALL_ROUTE_COL).in_(values),
                ),
            )
            .correlate(RunDB)
        )
        statement = statement.where(RUN_ID_COL.in_(call_provider_ids))
    if filters.tags:
        statement = apply_tag_filters(statement, filters.tags)
    if filters.search:
        # Wildcards in the user's text match literally — SQLite LIKE has
        # no default escape character, so ESCAPE is explicit.
        like = f"%{_escape_like_text(filters.search)}%"
        statement = statement.where(
            or_(
                RUN_ID_COL.like(like, escape="\\"),
                RUN_EXTERNAL_ID_COL.like(like, escape="\\"),
            )
        )
    if filters.min_duration_ms is not None or filters.max_duration_ms is not None:
        statement = apply_numeric_range(
            statement, RUN_DURATION_MS_COL, filters.min_duration_ms, filters.max_duration_ms
        )
    if filters.created_after or filters.created_before:
        statement = apply_date_range(
            statement, RunDB.created_at, filters.created_after, filters.created_before
        )
    return statement


def _apply_metric_filter(
    statement: Any, session: Session, filters: RunListFilters, scope: RunScope
) -> Any | None:
    """Restrict to runs with a matching metric row.

    Returns ``None`` when no run matches the metric+score filter, signalling
    the caller can short-circuit to an empty page without running the count
    or hydration queries.
    """
    if not filters.metric_name:
        return statement
    conditions: list[Any] = [RUN_METRIC_NAME_COL == filters.metric_name]
    if filters.min_score is not None:
        conditions.append(RUN_METRIC_SCORE_COL >= filters.min_score)
    if filters.max_score is not None:
        conditions.append(RUN_METRIC_SCORE_COL <= filters.max_score)

    # The probe keeps the empty-page fast path at the cost of one indexed
    # lookup. The match itself stays a subquery: a materialized id list can
    # exceed SQLite's host-parameter limit on large installs and pays a
    # Python round-trip per id.
    if session.exec(metric_runs(scope, *conditions).limit(1)).first() is None:
        return None
    return statement.where(runs_with_metrics(scope, *conditions))


def _apply_sort(statement: Any, sort_by: str | None, sort_order: str | None) -> Any:
    sort_field = sort_by if sort_by in VALID_SORT_FIELDS else "created_at"
    sort_col = _get_sort_column(sort_field)
    order = asc if sort_order == "asc" else desc
    return statement.order_by(order(sort_col))


def _get_sort_column(field: str | None) -> ColumnElement[object]:
    if field == "duration_ms":
        return cast(ColumnElement[object], RUN_DURATION_MS_COL)
    if field == "call_count":
        return cast(ColumnElement[object], as_column(cast(object, RunDB.call_count)))
    return cast(ColumnElement[object], RUN_CREATED_AT_COL)


def _hydrate_summaries(
    session: Session, runs: list[RunDB], scope: RunScope
) -> list[RunSummary]:
    # Trace ids collide across projects, so every hydration map is keyed by
    # the (run_id, project) pair of the page row it answers for. A run-id
    # key alone would let another project's copy of the trace decide this
    # row's status, metrics, and previews.
    page_rows = [(run.id, run.project) for run in runs]

    metrics_by_row = _load_metrics_by_run(session, page_rows, scope)
    calls_by_row = _load_calls_for_runs_without_metrics(
        session, runs, metrics_by_row, scope
    )
    levels_by_row = _load_levels_for_runs_needing_status(
        session, runs, metrics_by_row, calls_by_row, scope
    )

    summaries: list[RunSummary] = []
    for run in runs:
        key = (run.id, run.project)
        stored = metrics_by_row.get(key, [])
        calls_for_metrics: list[LoggedCallDB] = []
        if not stored and run.call_count > 0:
            calls_for_metrics = calls_by_row.get(key, [])
            metrics = calculate_run_metrics_from_calls(calls_for_metrics, run.id)
        else:
            metrics = stored

        error_count, warning_count = _count_levels(
            run, calls_for_metrics, levels_by_row.get(key, [])
        )
        status = (
            "error" if error_count > 0 else "warning" if warning_count > 0 else "success"
        )

        summaries.append(
            RunSummary(
                id=run.id,
                project=run.project,
                flow_name=run.flow_name,
                task_id=run.task_id,
                version=run.version,
                session_id=run.session_id,
                environment=run.environment,
                tags=run.tags or [],
                user_id=run.user_id,
                primary_model=run.primary_model,
                service_name=run.service_name,
                providers=provider_labels(
                    parse_model_providers(run.model_providers_json)
                ),
                bookmarked=run.bookmarked,
                task_run_id=run.task_run_id,
                call_count=run.call_count,
                duration_ms=run.duration_ms,
                created_at=run.created_at,
                completed_at=run.completed_at,
                status=status,
                error_count=error_count,
                warning_count=warning_count,
                metrics=[RunMetric.model_validate(m) for m in metrics],
                input_preview=_preview_or_none(run.input_preview),
                output_preview=_preview_or_none(run.output_preview),
            )
        )
    return summaries


def _preview_or_none(preview: str | None) -> str | None:
    # The page rows already carry the stored previews. ``has_preview_payload``
    # keeps a pre-v40 poisoned slot rendering empty until the resumable
    # backfill repairs it; there is deliberately no fallback to full call
    # I/O, which made one list render materialize tens of megabytes of JSON.
    return preview if has_preview_payload(preview) else None


def _load_metrics_by_run(
    session: Session, page_rows: Sequence[tuple[str, str]], scope: RunScope
) -> dict[tuple[str, str], list[RunMetricDB]]:
    if not page_rows:
        return {}
    query = select(RunMetricDB).where(metrics_of_page_rows(scope, page_rows))
    result: dict[tuple[str, str], list[RunMetricDB]] = {}
    for m in session.exec(query).all():
        if m.run_id is not None:
            result.setdefault((m.run_id, m.project), []).append(m)
    return result


def _load_calls_for_runs_without_metrics(
    session: Session,
    runs: list[RunDB],
    metrics_by_row: dict[tuple[str, str], list[RunMetricDB]],
    scope: RunScope,
) -> dict[tuple[str, str], list[LoggedCallDB]]:
    needing = [
        (r.id, r.project)
        for r in runs
        if not metrics_by_row.get((r.id, r.project)) and r.call_count > 0
    ]
    if not needing:
        return {}
    # The metric rollups read ``raw_usage``, so CALL_LIGHT's defer of it would
    # cost one lazy-load statement per call. Load exactly what the aggregates
    # and the level count read; ``raiseload`` turns a read of anything else
    # into an error instead of a silent per-row fetch.
    query = (
        select(LoggedCallDB)
        .options(
            load_only(
                LoggedCallDB.id,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.run_id,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.project,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.level,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.observation_type,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.latency_ms,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.cost,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.prompt_tokens,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.completion_tokens,  # pyright: ignore[reportArgumentType]
                LoggedCallDB.raw_usage,  # pyright: ignore[reportArgumentType]
                raiseload=True,
            )
        )
        .where(calls_of_page_rows(scope, needing))
    )
    result: dict[tuple[str, str], list[LoggedCallDB]] = {}
    for c in session.exec(query).all():
        if c.run_id is not None:
            result.setdefault((c.run_id, c.project), []).append(c)
    return result


def _load_levels_for_runs_needing_status(
    session: Session,
    runs: list[RunDB],
    metrics_by_row: dict[tuple[str, str], list[RunMetricDB]],
    calls_by_row: dict[tuple[str, str], list[LoggedCallDB]],
    scope: RunScope,
) -> dict[tuple[str, str], list[tuple[str, str]]]:
    needing = [
        (r.id, r.project)
        for r in runs
        if not calls_by_row.get((r.id, r.project))
        and r.call_count > 0
        and metrics_by_row.get((r.id, r.project))
    ]
    if not needing:
        return {}
    query = select(
        LoggedCallDB.level, LoggedCallDB.id, LoggedCallDB.run_id, LoggedCallDB.project
    ).where(calls_of_page_rows(scope, needing))
    result: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for row in session.exec(query).all():
        rid = row[2]
        if rid is not None:
            result.setdefault((rid, row[3]), []).append((row[0], row[1]))
    return result


def _count_levels(
    run: RunDB,
    calls_for_metrics: list[LoggedCallDB],
    level_rows: list[tuple[str, str]],
) -> tuple[int, int]:
    error_count = 0
    warning_count = 0
    if calls_for_metrics:
        for c in calls_for_metrics:
            if c.level == "ERROR":
                error_count += 1
            elif c.level == "WARNING":
                warning_count += 1
    elif run.call_count > 0:
        for level_value, _ in level_rows:
            if level_value == "ERROR":
                error_count += 1
            elif level_value == "WARNING":
                warning_count += 1
    return error_count, warning_count


def _escape_like_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
