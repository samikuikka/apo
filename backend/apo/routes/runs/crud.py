# pyright: reportCallInDefaultInitializer=false

import json
from datetime import datetime, timezone
from typing import Any, cast
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import asc, delete, desc, and_ as sql_and
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, func, or_, select

from ...db import get_session
from ...db_helpers import _as_column, _ensure_utc_datetime
from ...models import (
    RunDB,
    RunMetricDB,
    LoggedCallDB,
    Run,
    RunMetric,
    RunDetail,
    RunSummary,
    CreateRunRequest,
    UpdateRunRequest,
    LoggedCall,
    CorrectionRequest,
)
from ...metrics import calculate_and_store_aggregate_metrics
from ...services.demo_workspace import require_project_not_demo, require_run_not_demo
from ...services.filters import (
    apply_date_range,
    apply_numeric_range,
    apply_tag_filters,
)
from .metrics import calculate_run_metrics_from_calls

router = APIRouter(prefix="/v1/runs", tags=["runs"])


RUN_ID_COL: ColumnElement[str] = _as_column(cast(object, RunDB.id))
RUN_PROJECT_COL: ColumnElement[str] = _as_column(cast(object, RunDB.project))
RUN_CREATED_AT_COL: ColumnElement[datetime] = _as_column(cast(object, RunDB.created_at))
RUN_PRIMARY_MODEL_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunDB.primary_model)
)
RUN_EXTERNAL_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunDB.external_id)
)
RUN_DURATION_MS_COL: ColumnElement[float | None] = _as_column(
    cast(object, RunDB.duration_ms)
)
RUN_CALL_COUNT_COL: ColumnElement[int] = _as_column(
    cast(object, RunDB.call_count)
)
RUN_FLOW_NAME_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunDB.flow_name)
)
RUN_ENVIRONMENT_COL: ColumnElement[str] = _as_column(
    cast(object, RunDB.environment)
)
RUN_SESSION_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunDB.session_id)
)
RUN_USER_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunDB.user_id)
)
RUN_METRIC_SCORE_COL: ColumnElement[float | None] = _as_column(
    cast(object, RunMetricDB.score)
)
LOGGED_CALL_STEP_INDEX_COL: ColumnElement[int | None] = _as_column(
    cast(object, LoggedCallDB.step_index)
)
LOGGED_CALL_CREATED_AT_COL: ColumnElement[datetime] = _as_column(
    cast(object, LoggedCallDB.created_at)
)
RUN_METRIC_RUN_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunMetricDB.run_id)
)
RUN_METRIC_PROJECT_COL: ColumnElement[str] = _as_column(
    cast(object, RunMetricDB.project)
)
LOGGED_CALL_RUN_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, LoggedCallDB.run_id)
)
LOGGED_CALL_PROJECT_COL: ColumnElement[str] = _as_column(
    cast(object, LoggedCallDB.project)
)
LOGGED_CALL_MODEL_COL: ColumnElement[str] = _as_column(
    cast(object, LoggedCallDB.model)
)
LOGGED_CALL_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, LoggedCallDB.id)
)

PREVIEW_MAX_CHARS = 200


def _truncate_preview(value: object) -> str | None:
    if value is None:
        return None
    text = json.dumps(value, default=str) if not isinstance(value, str) else value
    if len(text) > PREVIEW_MAX_CHARS:
        return text[:PREVIEW_MAX_CHARS] + "..."
    return text


def _fetch_io_previews(
    session: Session, run_ids: list[str], project: str | None = None
) -> dict[str, dict[str, str | None]]:
    if not run_ids:
        return {}

    first_query = select(LoggedCallDB).where(
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
        span_query = select(LoggedCallDB).where(
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


class PaginatedRunSummary(BaseModel):
    data: list[RunSummary]
    total_count: int
    page: int
    page_size: int
    total_pages: int


@router.patch("/{run_id}/bookmark")
def toggle_bookmark(run_id: str, session: Session = Depends(get_session)):
    """Toggle bookmark state for a run."""
    run = require_run_not_demo(session, run_id)
    run.bookmarked = not run.bookmarked
    session.commit()
    session.refresh(run)

    return {"id": run.id, "bookmarked": run.bookmarked}


@router.post("", response_model=Run)
def create_run(request: CreateRunRequest, session: Session = Depends(get_session)):
    require_project_not_demo(request.project)
    run_id = str(uuid4())

    run = RunDB(
        id=run_id,
        project=request.project,
        task_id=request.task_id,
        flow_name=request.flow_name,
        version=request.version,
        user_id=request.user_id,
        session_id=request.session_id,
        environment=request.environment,
        external_id=request.external_id,
        tags=request.tags or [],
        run_metadata=request.run_metadata,
        primary_model=request.primary_model,
    )

    session.add(run)
    session.commit()
    session.refresh(run)

    return Run.model_validate(run)


@router.patch("/{run_id}", response_model=Run)
def update_run(
    run_id: str,
    request: UpdateRunRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    run = require_run_not_demo(session, run_id)

    _validate_trace_write_access(http_request, run.project)

    if request.completed:
        run.completed_at = datetime.now(timezone.utc)
        if run.created_at:
            duration = (
                _ensure_utc_datetime(run.completed_at)
                - _ensure_utc_datetime(run.created_at)
            ).total_seconds() * 1000
            run.duration_ms = duration

        aggregate_metrics = calculate_and_store_aggregate_metrics(session, run.id, run.project)
        for metric in aggregate_metrics:
            session.add(metric)

    if request.call_count is not None:
        run.call_count = request.call_count

    session.commit()
    session.refresh(run)

    return Run.model_validate(run)


def _validate_trace_write_access(request: Request, run_project: str) -> None:
    if getattr(request.state, "auth_method", None) != "service_token":
        return
    token_project = getattr(request.state, "project", None)
    if token_project != run_project:
        raise HTTPException(status_code=403, detail="Service token project mismatch")


VALID_SORT_FIELDS = {"created_at", "duration_ms", "call_count"}


def _get_sort_column(field: str):
    if field == "duration_ms":
        return RUN_DURATION_MS_COL
    if field == "call_count":
        return _as_column(cast(object, RunDB.call_count))
    return RUN_CREATED_AT_COL


@router.get("", response_model=PaginatedRunSummary)
def list_runs(
    project: str | None = None,
    flow_name: str | None = Query(None, description="Comma-separated flow_name list"),
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    page_size: int = Query(
        40, ge=1, le=100, description="Number of items per page (max 100)"
    ),
    environment: str | None = Query(None, description="Comma-separated environment list"),
    session_id: str | None = Query(None, description="Comma-separated session ID list"),
    user_id: str | None = Query(None, description="Comma-separated user ID list"),
    tags: str | None = Query(None, description="Comma-separated tag list"),
    models: str | None = Query(None, description="Comma-separated model list"),
    metric_name: str | None = Query(None, description="Filter by metric name"),
    min_score: float | None = Query(None, description="Minimum metric score"),
    max_score: float | None = Query(None, description="Maximum metric score"),
    search: str | None = Query(None, description="Search by run_id or external_id"),
    min_duration_ms: float | None = None,
    max_duration_ms: float | None = None,
    created_after: str | None = Query(None, description="ISO 8601 datetime"),
    created_before: str | None = Query(None, description="ISO 8601 datetime"),
    sort_by: str | None = Query(None, description="Sort field: created_at, duration_ms, call_count"),
    sort_order: str | None = Query("desc", description="Sort direction: asc or desc"),
    status: str | None = Query(None, description="Comma-separated status list: success, warning, error"),
    bookmarked: bool | None = Query(None, description="Filter bookmarked traces"),
    session: Session = Depends(get_session),
):
    statement = select(RunDB)

    if project:
        statement = statement.where(RunDB.project == project)

    flow_name_list = [s.strip() for s in (flow_name or "").split(",") if s.strip()]
    if flow_name_list:
        statement = statement.where(RUN_FLOW_NAME_COL.in_(flow_name_list))

    env_list = [e.strip() for e in (environment or "").split(",") if e.strip()]
    if env_list:
        statement = statement.where(RUN_ENVIRONMENT_COL.in_(env_list))

    session_list = [s.strip() for s in (session_id or "").split(",") if s.strip()]
    if session_list:
        statement = statement.where(RUN_SESSION_ID_COL.in_(session_list))

    user_list = [u.strip() for u in (user_id or "").split(",") if u.strip()]
    if user_list:
        statement = statement.where(RUN_USER_ID_COL.in_(user_list))

    if models:
        model_list = [m.strip() for m in models.split(",") if m.strip()]
        if model_list:
            call_model_ids = select(LOGGED_CALL_RUN_ID_COL).where(
                LOGGED_CALL_RUN_ID_COL.is_not(None),
                LOGGED_CALL_MODEL_COL.in_(model_list),
            )
            statement = statement.where(
                or_(
                    RUN_PRIMARY_MODEL_COL.in_(model_list),
                    RUN_ID_COL.in_(call_model_ids),
                )
            )

    if metric_name:
        metric_subquery = select(RunMetricDB.run_id).where(
            RunMetricDB.metric_name == metric_name
        )
        if min_score is not None:
            metric_subquery = metric_subquery.where(RUN_METRIC_SCORE_COL >= min_score)
        if max_score is not None:
            metric_subquery = metric_subquery.where(RUN_METRIC_SCORE_COL <= max_score)

        matching_run_ids = cast(list[str], session.exec(metric_subquery).all())
        if matching_run_ids:
            statement = statement.where(RUN_ID_COL.in_(matching_run_ids))
        else:
            return PaginatedRunSummary(
                data=[],
                total_count=0,
                page=page,
                page_size=page_size,
                total_pages=0,
            )

    if tags:
        statement = apply_tag_filters(statement, tags)

    if search:
        statement = statement.where(
            or_(
                RUN_ID_COL.like(f"%{search}%"),
                RUN_EXTERNAL_ID_COL.like(f"%{search}%"),
            )
        )

    if min_duration_ms is not None or max_duration_ms is not None:
        statement = apply_numeric_range(
            statement, RUN_DURATION_MS_COL, min_duration_ms, max_duration_ms
        )

    if created_after or created_before:
        statement = apply_date_range(
            statement, RunDB.created_at, created_after, created_before
        )

    if status:
        LOGGED_CALL_LEVEL_COL: ColumnElement[str | None] = _as_column(
            cast(object, LoggedCallDB.level)
        )
        status_values = [s.strip() for s in status.split(",") if s.strip()]
        status_conditions: list[Any] = []
        if "error" in status_values:
            error_sub = select(LoggedCallDB.run_id).where(
                LOGGED_CALL_LEVEL_COL == "ERROR"
            )
            status_conditions.append(RUN_ID_COL.in_(error_sub))
        if "warning" in status_values:
            warning_sub = select(LoggedCallDB.run_id).where(
                LOGGED_CALL_LEVEL_COL == "WARNING"
            )
            error_sub = select(LoggedCallDB.run_id).where(
                LOGGED_CALL_LEVEL_COL == "ERROR"
            )
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

    if bookmarked is not None:
        statement = statement.where(RunDB.bookmarked == bookmarked)

    count_statement = select(func.count()).select_from(statement.subquery())
    total_count = session.exec(count_statement).one()

    total_pages = (total_count + page_size - 1) // page_size if total_count > 0 else 0

    sort_field = sort_by if sort_by in VALID_SORT_FIELDS else "created_at"
    sort_col = _get_sort_column(sort_field)
    if sort_order == "asc":
        statement = statement.order_by(asc(cast(ColumnElement[object], sort_col)))
    else:
        statement = statement.order_by(desc(cast(ColumnElement[object], sort_col)))
    statement = statement.offset(page * page_size).limit(page_size)

    runs = session.exec(statement).all()

    run_ids = [r.id for r in runs]

    metrics_query = select(RunMetricDB).where(RUN_METRIC_RUN_ID_COL.in_(run_ids))
    if project is not None:
        metrics_query = metrics_query.where(RUN_METRIC_PROJECT_COL == project)
    all_metrics = session.exec(metrics_query).all()
    metrics_by_run: dict[str, list[RunMetricDB]] = {}
    for m in all_metrics:
        if m.run_id is not None:
            metrics_by_run.setdefault(m.run_id, []).append(m)

    runs_needing_calls = [
        r.id for r in runs if not metrics_by_run.get(r.id) and r.call_count > 0
    ]
    calls_by_run: dict[str, list[LoggedCallDB]] = {}
    if runs_needing_calls:
        calls_query = select(LoggedCallDB).where(
            LOGGED_CALL_RUN_ID_COL.in_(runs_needing_calls)
        )
        if project is not None:
            calls_query = calls_query.where(LOGGED_CALL_PROJECT_COL == project)
        all_calls = session.exec(calls_query).all()
        for c in all_calls:
            if c.run_id is not None:
                calls_by_run.setdefault(c.run_id, []).append(c)

    runs_needing_levels = [
        r.id
        for r in runs
        if not calls_by_run.get(r.id) and r.call_count > 0 and metrics_by_run.get(r.id)
    ]
    levels_by_run: dict[str, list[tuple[str | None, str]]] = {}
    if runs_needing_levels:
        levels_query = select(LoggedCallDB.level, LoggedCallDB.id, LoggedCallDB.run_id).where(
            LOGGED_CALL_RUN_ID_COL.in_(runs_needing_levels)
        )
        if project is not None:
            levels_query = levels_query.where(LOGGED_CALL_PROJECT_COL == project)
        level_rows = session.exec(levels_query).all()
        for lvl, cid, rid in level_rows:
            if rid is not None:
                levels_by_run.setdefault(rid, []).append((lvl, cid))

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

        error_count = 0
        warning_count = 0
        if calls_for_metrics:
            for c in calls_for_metrics:
                if c.level == "ERROR":
                    error_count += 1
                elif c.level == "WARNING":
                    warning_count += 1
        elif run.call_count > 0:
            for lvl, _ in levels_by_run.get(run.id, []):
                if lvl == "ERROR":
                    error_count += 1
                elif lvl == "WARNING":
                    warning_count += 1

        status = "error" if error_count > 0 else "warning" if warning_count > 0 else "success"

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

    return PaginatedRunSummary(
        data=summaries,
        total_count=total_count,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.get("/distinct-projects")
def get_distinct_projects(session: Session = Depends(get_session)):
    projects = session.exec(select(RunDB.project).distinct()).all()
    return [p[0] for p in projects]


@router.get("/distinct-tasks")
def get_distinct_tasks(session: Session = Depends(get_session)):
    tasks = session.exec(
        select(RunDB.task_id).distinct().where(RunDB.task_id != None)
    ).all()
    return [task_id for task_id in tasks if task_id is not None]


@router.get("/distinct-models")
def get_distinct_models(session: Session = Depends(get_session)):
    models = session.exec(
        select(RunDB.primary_model).distinct().where(RunDB.primary_model != None)
    ).all()
    return [model for model in models if model is not None]


@router.get("/distinct-metrics")
def get_distinct_metrics(session: Session = Depends(get_session)):
    metrics = session.exec(select(RunMetricDB.metric_name).distinct()).all()
    return [m[0] for m in metrics]


@router.get("/{run_id}")
def get_run_details(
    run_id: str,
    project: str = "default",
    session: Session = Depends(get_session),
):
    run = session.exec(
        select(RunDB).where(RunDB.id == run_id, RunDB.project == project)
    ).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    calls = session.exec(
        select(LoggedCallDB)
        .where(
            LoggedCallDB.run_id == run_id,
            LoggedCallDB.project == project,
        )
        .order_by(
            asc(LOGGED_CALL_STEP_INDEX_COL).nulls_last(),
            asc(LOGGED_CALL_CREATED_AT_COL),
        )
    ).all()

    stored_metrics = session.exec(
        select(RunMetricDB).where(
            RunMetricDB.run_id == run_id,
            RunMetricDB.project == project,
        )
    ).all()

    aggregate_metrics = calculate_run_metrics_from_calls(list(calls), run_id)

    metrics_dict: dict[str, RunMetricDB] = {}
    for metric in stored_metrics:
        metrics_dict[metric.metric_name] = metric
    for metric in aggregate_metrics:
        metrics_dict[metric.metric_name] = metric

    all_metrics = list(metrics_dict.values())

    calls_models: list[LoggedCall] = [
        LoggedCall.model_validate(call, from_attributes=True) for call in calls
    ]

    return RunDetail(
        run=Run.model_validate(run),
        metrics=[RunMetric.model_validate(m) for m in all_metrics],
        calls=calls_models,
    ).model_dump(by_alias=True)


class CustomMetricResult(BaseModel):
    name: str
    score: float
    error: str | None = None


class PostCustomMetricsRequest(BaseModel):
    metrics: list[CustomMetricResult]


@router.post("/{run_id}/custom-metrics")
async def post_custom_metrics(
    run_id: str,
    request: PostCustomMetricsRequest,
    session: Session = Depends(get_session),
):
    _run = require_run_not_demo(session, run_id)

    results_count = 0
    errors: list[dict[str, str]] = []
    for metric_result in request.metrics:
        try:
            metric_db = RunMetricDB(
                run_id=run_id,
                metric_name=metric_result.name,
                metric_type="quality",
                score=metric_result.score,
                data_type="NUMERIC",
                source="API",
                reasoning=None
                if not metric_result.error
                else f"Error: {metric_result.error}",
                meta={"sdk_custom": True, "error": metric_result.error}
                if metric_result.error
                else {"sdk_custom": True},
            )
            session.add(metric_db)
            results_count += 1
        except Exception as e:
            errors.append({"name": metric_result.name, "error": str(e)})

    session.commit()

    return {
        "status": "success" if not errors else "partial",
        "run_id": run_id,
        "metrics_stored": results_count,
        "errors": errors if errors else None,
    }


@router.patch("/{run_id}/calls/{call_id}/correction")
def set_corrected_output(
    run_id: str,
    call_id: str,
    request: CorrectionRequest,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Set or clear the corrected output for a call."""
    _run = require_run_not_demo(session, run_id, project)
    call = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.id == call_id, LoggedCallDB.project == project
        )
    ).first()
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if call.run_id != run_id:
        raise HTTPException(status_code=400, detail="Call does not belong to this run")

    call.corrected_output = request.corrected_output
    session.commit()
    session.refresh(call)

    return {"id": call.id, "corrected_output": call.corrected_output}


class BulkDeleteRequest(BaseModel):
    run_ids: list[str]


@router.post("/bulk-delete")
def bulk_delete_runs(
    request: BulkDeleteRequest,
    project: str = "default",
    session: Session = Depends(get_session),
):
    if not request.run_ids:
        raise HTTPException(status_code=400, detail="No run IDs provided")

    existing_runs = session.exec(
        select(RunDB).where(
            RUN_ID_COL.in_(request.run_ids), RUN_PROJECT_COL == project
        )
    ).all()

    run_id_map = {r.id: r for r in existing_runs}
    missing_run_ids = set(request.run_ids) - set(run_id_map)

    if missing_run_ids:
        raise HTTPException(
            status_code=404, detail=f"Runs not found: {', '.join(missing_run_ids)}"
        )

    for run in existing_runs:
        require_project_not_demo(run.project)

    # Scope cascade deletes by project so a shared OTel id cannot delete another
    # project's metrics/calls (SPEC-133 M4).
    deleted_metrics = session.exec(
        delete(RunMetricDB).where(
            _as_column(cast(object, RunMetricDB.run_id)).in_(request.run_ids),
            _as_column(cast(object, RunMetricDB.project)) == project,
        )
    )

    deleted_calls = session.exec(
        delete(LoggedCallDB).where(
            _as_column(cast(object, LoggedCallDB.run_id)).in_(request.run_ids),
            _as_column(cast(object, LoggedCallDB.project)) == project,
        )
    )

    _ = session.exec(
        delete(RunDB).where(RUN_ID_COL.in_(request.run_ids), RUN_PROJECT_COL == project)
    )

    session.commit()

    return {
        "deleted_runs": len(request.run_ids),
        "deleted_metrics": deleted_metrics.rowcount if deleted_metrics else 0,
        "deleted_calls": deleted_calls.rowcount if deleted_calls else 0,
    }


class BulkExportRequest(BaseModel):
    run_ids: list[str]
    format: str = "json"


@router.post("/bulk-export")
def bulk_export_runs(
    request: BulkExportRequest,
    project: str = "default",
    session: Session = Depends(get_session),
):
    if not request.run_ids:
        raise HTTPException(status_code=400, detail="No run IDs provided")

    runs_in_db = session.exec(
        select(RunDB).where(
            RUN_ID_COL.in_(request.run_ids), RUN_PROJECT_COL == project
        )
    ).all()
    run_id_map = {r.id: r for r in runs_in_db}

    export_run_ids = [rid for rid in request.run_ids if rid in run_id_map]

    all_metrics = session.exec(
        select(RunMetricDB).where(
            RUN_METRIC_RUN_ID_COL.in_(export_run_ids),
            RUN_METRIC_PROJECT_COL == project,
        )
    ).all()
    metrics_by_run: dict[str, list[RunMetricDB]] = {}
    for m in all_metrics:
        if m.run_id is not None:
            metrics_by_run.setdefault(m.run_id, []).append(m)

    all_calls = session.exec(
        select(LoggedCallDB)
        .where(
            LOGGED_CALL_RUN_ID_COL.in_(export_run_ids),
            LOGGED_CALL_PROJECT_COL == project,
        )
        .order_by(
            asc(LOGGED_CALL_STEP_INDEX_COL).nulls_last(),
            asc(LOGGED_CALL_CREATED_AT_COL),
        )
    ).all()
    calls_by_run: dict[str, list[LoggedCallDB]] = {}
    for c in all_calls:
        if c.run_id is not None:
            calls_by_run.setdefault(c.run_id, []).append(c)

    runs_data: list[dict[str, object]] = []
    for run_id in export_run_ids:
        run = run_id_map[run_id]
        runs_data.append(
            {
                "run": Run.model_validate(run).model_dump(by_alias=True),
                "metrics": [
                    RunMetric.model_validate(m).model_dump(by_alias=True)
                    for m in metrics_by_run.get(run_id, [])
                ],
                "calls": [
                    LoggedCall.model_validate(c, from_attributes=True).model_dump(by_alias=True)
                    for c in calls_by_run.get(run_id, [])
                ],
            }
        )

    if request.format == "csv":
        import csv
        from io import StringIO

        output = StringIO()
        writer = csv.writer(output)

        writer.writerow(
            [
                "Run ID",
                "Project",
                "Flow Name",
                "Task ID",
                "Version",
                "Environment",
                "Created At",
                "Completed At",
                "Duration (ms)",
                "Call Count",
                "Tags",
                "Metrics Count",
            ]
        )

        for run_item in runs_data:
            run = cast(dict[str, object], run_item["run"])
            metrics = cast(list[object], run_item["metrics"])
            tags_value = run.get("tags")
            tags: list[object] = (
                cast(list[object], tags_value) if isinstance(tags_value, list) else []
            )
            writer.writerow(
                [
                    run.get("id"),
                    run.get("project"),
                    run.get("flow_name") or "",
                    run.get("task_id") or "",
                    run.get("version") or "",
                    run.get("environment") or "",
                    run.get("created_at") or "",
                    run.get("completed_at") or "",
                    run.get("duration_ms") or "",
                    run.get("call_count") or 0,
                    ",".join(str(tag) for tag in tags),
                    len(metrics),
                ]
            )

        csv_content = output.getvalue()
        return JSONResponse(
            content={
                "data": csv_content,
                "filename": f"runs_export_{len(request.run_ids)}_runs.csv",
                "media_type": "text/csv",
            }
        )
    else:
        json_content = json.dumps(runs_data, indent=2, default=str)
        return JSONResponse(
            content={
                "data": json_content,
                "filename": f"runs_export_{len(request.run_ids)}_runs.json",
                "media_type": "application/json",
            }
        )


# ── SPEC-129 Criterion #2: Replay / re-projection ─────────────────────────


@router.post("/{run_id}/reproject")
def reproject_run(
    run_id: str,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Re-project a trace's canonical spans through the normalizer.

    Reads canonical spans from ``OtlpSpanDB`` and re-projects them into
    ``RunDB`` / ``LoggedCallDB``. Use this after a mapper change to update
    the product tables without re-ingesting the raw payload.

    SPEC-129 Criterion #2: "The same raw canonical span can be replayed to
    produce a new Trace Projection after a mapper change."

    The ``project`` query parameter specifies which project the trace belongs
    to (required because canonical spans are scoped by project).
    """
    from ...models.db import OtlpSpanDB as _OtlpSpanDB
    from ...services.reproject import reproject_trace

    # Resolve the canonical span scoped by ``(trace_id, project)`` so two
    # projects sharing an OTel id each re-project their own trace.
    canonical = session.exec(
        select(_OtlpSpanDB).where(
            _OtlpSpanDB.trace_id == run_id, _OtlpSpanDB.project_id == project
        ).limit(1)
    ).first()
    if canonical is None:
        raise HTTPException(status_code=404, detail="Trace not found in canonical store")

    count = reproject_trace(run_id, project_id=project)
    return {"trace_id": run_id, "project": project, "reprojected_spans": count}
