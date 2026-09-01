# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryComparison=false, reportUnusedCallResult=false

"""Run-list query, hydration, and status computation.

Extracted from the ``GET /v1/runs`` handler so the filtering, pagination,
multi-query hydration, and per-run status derivation are exercisable
without going through FastAPI/HTTP. The route handler stays responsible
for parsing query params, enforcing project-scope auth, and returning
the HTTP response; everything from the ``select(RunDB)`` onward lives
here.
"""

from dataclasses import dataclass, field
from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import asc, desc, and_ as sql_and
from sqlalchemy.orm import defer
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, func, or_, select

from ...db_helpers import as_column
from ...models import LoggedCallDB, RunDB, RunMetricDB, RunMetric, RunSummary
from ...services.filters import apply_date_range, apply_numeric_range, apply_tag_filters
from ...models.columns import (
    CALL_LIGHT,
    LOGGED_CALL_CREATED_AT_COL,
    LOGGED_CALL_LEVEL_COL,
    LOGGED_CALL_MODEL_COL,
    LOGGED_CALL_PROJECT_COL,
    LOGGED_CALL_RUN_ID_COL,
    RUN_CALL_COUNT_COL,
    RUN_CREATED_AT_COL,
    RUN_DURATION_MS_COL,
    RUN_ENVIRONMENT_COL,
    RUN_EXTERNAL_ID_COL,
    RUN_FLOW_NAME_COL,
    RUN_ID_COL,
    RUN_PRIMARY_MODEL_COL,
    RUN_PROJECT_COL,
    RUN_SESSION_ID_COL,
    RUN_TASK_ID_COL,
    RUN_USER_ID_COL,
    RUN_METRIC_PROJECT_COL,
    RUN_METRIC_RUN_ID_COL,
    RUN_METRIC_SCORE_COL,
)
from ...services.projection_io import list_read_mode, truncate_preview
from ...services.trace_search import apply_trace_search
from .metrics import calculate_run_metrics_from_calls


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


@dataclass
class RunListPagination:
    page: int
    page_size: int
    sort_by: str | None
    sort_order: str | None


def list_run_summaries(
    session: Session, filters: RunListFilters, pagination: RunListPagination
) -> PaginatedRunSummary:
    statement = _apply_project_scope(
        select(RunDB), filters.project, filters.allowed_projects
    )
    statement = _apply_attribute_filters(statement, filters)
    statement = _apply_metric_filter(statement, session, filters)
    if statement is None:
        return _empty_page(pagination)
    statement = _apply_status_filter(statement, filters.status_values)
    if filters.bookmarked is not None:
        statement = statement.where(RunDB.bookmarked == filters.bookmarked)
    # Span-derived predicates MUST land before the total_count
    # subquery below, or pages filter but counts do not.
    statement = apply_trace_search(
        statement,
        service=filters.service,
        operation=filters.operation,
        span_text=filters.span_text,
        predicates=filters.span_predicates,
    )

    total_count = session.exec(
        select(func.count()).select_from(statement.subquery())
    ).one()
    total_pages = (
        (total_count + pagination.page_size - 1) // pagination.page_size
        if total_count > 0
        else 0
    )

    statement = _apply_sort(
        statement, pagination.sort_by, pagination.sort_order
    ).offset(pagination.page * pagination.page_size).limit(pagination.page_size)

    runs = session.exec(statement).all()
    summaries = _hydrate_summaries(session, runs, filters.project)
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


def _apply_project_scope(
    statement: Any, project: str | None, allowed_projects: list[str] | None
) -> Any:
    if project:
        return statement.where(RUN_PROJECT_COL == project)
    if allowed_projects is not None:
        return statement.where(RUN_PROJECT_COL.in_(allowed_projects))
    return statement


def _apply_attribute_filters(statement: Any, filters: RunListFilters) -> Any:
    if filters.flow_names:
        statement = statement.where(RUN_FLOW_NAME_COL.in_(filters.flow_names))
    if filters.task_ids:
        statement = statement.where(RUN_TASK_ID_COL.in_(filters.task_ids))
    if filters.environments:
        statement = statement.where(RUN_ENVIRONMENT_COL.in_(filters.environments))
    if filters.session_ids:
        statement = statement.where(RUN_SESSION_ID_COL.in_(filters.session_ids))
    if filters.user_ids:
        statement = statement.where(RUN_USER_ID_COL.in_(filters.user_ids))
    if filters.models:
        call_model_ids = select(LOGGED_CALL_RUN_ID_COL).where(
            LOGGED_CALL_RUN_ID_COL.is_not(None),
            LOGGED_CALL_MODEL_COL.in_(filters.models),
        )
        statement = statement.where(
            or_(
                RUN_PRIMARY_MODEL_COL.in_(filters.models),
                RUN_ID_COL.in_(call_model_ids),
            )
        )
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
    statement: Any, session: Session, filters: RunListFilters
) -> Any | None:
    """Restrict to runs with a matching metric row.

    Returns ``None`` when no run matches the metric+score filter, signalling
    the caller can short-circuit to an empty page without running the count
    or hydration queries.
    """
    if not filters.metric_name:
        return statement
    metric_subquery = select(RunMetricDB.run_id).where(
        RunMetricDB.metric_name == filters.metric_name
    )
    if filters.min_score is not None:
        metric_subquery = metric_subquery.where(RUN_METRIC_SCORE_COL >= filters.min_score)
    if filters.max_score is not None:
        metric_subquery = metric_subquery.where(RUN_METRIC_SCORE_COL <= filters.max_score)

    matching_run_ids = cast(list[str], session.exec(metric_subquery).all())
    if not matching_run_ids:
        return None
    return statement.where(RUN_ID_COL.in_(matching_run_ids))


def _apply_status_filter(statement: Any, status_values: list[str]) -> Any:
    if not status_values:
        return statement
    status_conditions: list[Any] = []
    if "error" in status_values:
        error_sub = select(LoggedCallDB.run_id).where(LOGGED_CALL_LEVEL_COL == "ERROR")
        status_conditions.append(RUN_ID_COL.in_(error_sub))
    if "warning" in status_values:
        warning_sub = select(LoggedCallDB.run_id).where(LOGGED_CALL_LEVEL_COL == "WARNING")
        error_sub = select(LoggedCallDB.run_id).where(LOGGED_CALL_LEVEL_COL == "ERROR")
        status_conditions.append(
            sql_and(RUN_ID_COL.in_(warning_sub), RUN_ID_COL.not_in(error_sub))
        )
    if "success" in status_values:
        issues_sub = select(LoggedCallDB.run_id).where(
            LOGGED_CALL_LEVEL_COL.in_(["ERROR", "WARNING"])
        )
        status_conditions.append(
            sql_and(RUN_ID_COL.not_in(issues_sub), RUN_CALL_COUNT_COL > 0)
        )
    if status_conditions:
        statement = statement.where(or_(*status_conditions))
    return statement


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
    session: Session, runs: list[RunDB], project: str | None
) -> list[RunSummary]:
    run_ids = [r.id for r in runs]

    metrics_by_run = _load_metrics_by_run(session, run_ids, project)
    calls_by_run = _load_calls_for_runs_without_metrics(
        session, runs, metrics_by_run, project
    )
    levels_by_run = _load_levels_for_runs_needing_status(
        session, runs, metrics_by_run, calls_by_run, project
    )
    preview_by_run = _fetch_io_previews(session, run_ids, project)

    summaries: list[RunSummary] = []
    for run in runs:
        stored = metrics_by_run.get(run.id, [])
        calls_for_metrics: list[LoggedCallDB] = []
        if not stored and run.call_count > 0:
            calls_for_metrics = calls_by_run.get(run.id, [])
            metrics = calculate_run_metrics_from_calls(calls_for_metrics, run.id)
        else:
            metrics = stored

        error_count, warning_count = _count_levels(
            run, calls_for_metrics, levels_by_run.get(run.id, [])
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
                input_preview=preview_by_run.get(run.id, {}).get("input"),
                output_preview=preview_by_run.get(run.id, {}).get("output"),
            )
        )
    return summaries


def _load_metrics_by_run(
    session: Session, run_ids: list[str], project: str | None
) -> dict[str, list[RunMetricDB]]:
    if not run_ids:
        return {}
    query = select(RunMetricDB).where(RUN_METRIC_RUN_ID_COL.in_(run_ids))
    if project is not None:
        query = query.where(RUN_METRIC_PROJECT_COL == project)
    result: dict[str, list[RunMetricDB]] = {}
    for m in session.exec(query).all():
        if m.run_id is not None:
            result.setdefault(m.run_id, []).append(m)
    return result


def _load_calls_for_runs_without_metrics(
    session: Session,
    runs: list[RunDB],
    metrics_by_run: dict[str, list[RunMetricDB]],
    project: str | None,
) -> dict[str, list[LoggedCallDB]]:
    needing = [
        r.id for r in runs if not metrics_by_run.get(r.id) and r.call_count > 0
    ]
    if not needing:
        return {}
    query = (
        select(LoggedCallDB)
        .options(
            *CALL_LIGHT,
            defer(LoggedCallDB.input),  # pyright: ignore[reportArgumentType]
            defer(LoggedCallDB.output),  # pyright: ignore[reportArgumentType]
        )
        .where(LOGGED_CALL_RUN_ID_COL.in_(needing))
    )
    if project is not None:
        query = query.where(LOGGED_CALL_PROJECT_COL == project)
    result: dict[str, list[LoggedCallDB]] = {}
    for c in session.exec(query).all():
        if c.run_id is not None:
            result.setdefault(c.run_id, []).append(c)
    return result


def _load_levels_for_runs_needing_status(
    session: Session,
    runs: list[RunDB],
    metrics_by_run: dict[str, list[RunMetricDB]],
    calls_by_run: dict[str, list[LoggedCallDB]],
    project: str | None,
) -> dict[str, list[tuple[str, str]]]:
    needing = [
        r.id
        for r in runs
        if not calls_by_run.get(r.id)
        and r.call_count > 0
        and metrics_by_run.get(r.id)
    ]
    if not needing:
        return {}
    query = select(LoggedCallDB.level, LoggedCallDB.id, LoggedCallDB.run_id).where(
        LOGGED_CALL_RUN_ID_COL.in_(needing)
    )
    if project is not None:
        query = query.where(LOGGED_CALL_PROJECT_COL == project)
    result: dict[str, list[tuple[str, str]]] = {}
    for row in session.exec(query).all():
        rid = row[2]
        if rid is not None:
            result.setdefault(rid, []).append((row[0], row[1]))
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


def _fetch_io_previews(
    session: Session, run_ids: list[str], project: str | None
) -> dict[str, dict[str, str | None]]:
    if not run_ids:
        return {}

    if list_read_mode() == "previews":
        # Write-time previews first — the whole point is never touching the
        # fat I/O columns on list renders. Runs without a stored preview
        # (pre-Stage-2 rows, or the backfill hasn't reached them) fall back
        # to the legacy truncation path individually.
        query = select(
            as_column(RunDB.id),
            as_column(RunDB.input_preview),
            as_column(RunDB.output_preview),
        ).where(as_column(RunDB.id).in_(run_ids))
        if project is not None:
            query = query.where(as_column(RunDB.project) == project)
        previewed: dict[str, dict[str, str | None]] = {}
        for row in cast("list[tuple[object, ...]]", cast(object, session.exec(query).all())):
            run_id = str(row[0])
            input_preview = cast("str | None", row[1])
            output_preview = cast("str | None", row[2])
            if input_preview is None and output_preview is None:
                continue
            previewed[run_id] = {"input": input_preview, "output": output_preview}
        legacy = _legacy_io_previews(
            session, [rid for rid in run_ids if rid not in previewed], project
        )
        previewed.update(legacy)
        for rid in run_ids:
            if rid not in previewed:
                previewed[rid] = {"input": None, "output": None}
        return previewed

    return _legacy_io_previews(session, run_ids, project)


def _legacy_io_previews(
    session: Session, run_ids: list[str], project: str | None
) -> dict[str, dict[str, str | None]]:
    if not run_ids:
        return {}

    first_query = select(LoggedCallDB).options(*CALL_LIGHT).where(
        LOGGED_CALL_RUN_ID_COL.in_(run_ids),
        LoggedCallDB.observation_type == "GENERATION",
    )
    if project is not None:
        first_query = first_query.where(LOGGED_CALL_PROJECT_COL == project)
    first_calls = session.exec(first_query.order_by(LOGGED_CALL_CREATED_AT_COL)).all()

    seen_runs: set[str] = set()
    result: dict[str, dict[str, str | None]] = {}
    for call in first_calls:
        if call.run_id is None or call.run_id in seen_runs:
            continue
        seen_runs.add(call.run_id)
        result[call.run_id] = {
            "input": _truncate_preview(call.input),
            "output": _truncate_preview(call.output),
        }

    runs_without_gen = [rid for rid in run_ids if rid not in seen_runs]
    if runs_without_gen:
        span_query = select(LoggedCallDB).options(*CALL_LIGHT).where(
            LOGGED_CALL_RUN_ID_COL.in_(runs_without_gen)
        )
        if project is not None:
            span_query = span_query.where(LOGGED_CALL_PROJECT_COL == project)
        span_calls = session.exec(span_query.order_by(LOGGED_CALL_CREATED_AT_COL)).all()
        seen_spans: set[str] = set()
        for call in span_calls:
            if call.run_id is None or call.run_id in seen_spans:
                continue
            seen_spans.add(call.run_id)
            result[call.run_id] = {
                "input": _truncate_preview(call.input),
                "output": _truncate_preview(call.output),
            }

    for rid in run_ids:
        if rid not in result:
            result[rid] = {"input": None, "output": None}

    return result


_truncate_preview = truncate_preview
