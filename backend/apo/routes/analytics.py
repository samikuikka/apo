"""
Trace filtering, search, and analytics API.

Provides structured query endpoints for traces and observations with filtering,
aggregation, and analytics capabilities.
"""

# pyright: reportCallInDefaultInitializer=false, reportDeprecated=false, reportAny=false

from datetime import datetime
from typing import Any, cast

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import desc, asc, text as sql_text, func, select as sa_select
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, select

from ..db import get_session
from ..db_helpers import _as_column
from ..models.db import RunDB, LoggedCallDB, RunMetricDB
from ..services.filters import (
    apply_date_range,
    apply_numeric_range,
    apply_tag_all_filter,
    apply_tag_any_filter,
)
from ..services.metrics import compute_aggregate, compute_percentile

router = APIRouter(prefix="/api/v1", tags=["analytics"])


RUN_ID_COL: ColumnElement[str] = _as_column(cast(object, RunDB.id))
RUN_CREATED_AT_COL: ColumnElement[datetime] = _as_column(cast(object, RunDB.created_at))
RUN_DURATION_MS_COL: ColumnElement[float | None] = _as_column(cast(object, RunDB.duration_ms))
CALL_LATENCY_MS_COL: ColumnElement[float | None] = _as_column(cast(object, LoggedCallDB.latency_ms))
CALL_COST_COL: ColumnElement[float | None] = _as_column(cast(object, LoggedCallDB.cost))
CALL_CREATED_AT_COL: ColumnElement[datetime] = _as_column(cast(object, LoggedCallDB.created_at))
CALL_TOTAL_TOKENS_COL: ColumnElement[int | None] = _as_column(cast(object, LoggedCallDB.total_tokens))
CALL_MODEL_COL: ColumnElement[str] = _as_column(cast(object, LoggedCallDB.model))
CALL_OBSERVATION_TYPE_COL: ColumnElement[str] = _as_column(cast(object, LoggedCallDB.observation_type))
CALL_LEVEL_COL: ColumnElement[str] = _as_column(cast(object, LoggedCallDB.level))
CALL_RUN_ID_COL: ColumnElement[str | None] = _as_column(cast(object, LoggedCallDB.run_id))
RUN_METRIC_SCORE_COL: ColumnElement[float | None] = _as_column(cast(object, RunMetricDB.score))


class TraceFilter(BaseModel):
    project: str
    from_timestamp: datetime | None = None
    to_timestamp: datetime | None = None
    flow_name: str | None = None
    user_id: str | None = None
    session_id: str | None = None
    environment: str | None = None
    tags_any: list[str] | None = None
    tags_all: list[str] | None = None
    min_cost: float | None = None
    max_cost: float | None = None
    min_latency_ms: float | None = None
    max_latency_ms: float | None = None
    has_errors: bool | None = None
    min_score: float | None = None
    score_name: str | None = None
    limit: int = Field(default=50, le=200)
    offset: int = Field(default=0, ge=0)
    order_by: str = "created_at"
    order_dir: str = "desc"


class ObservationFilter(BaseModel):
    project: str
    from_timestamp: datetime | None = None
    to_timestamp: datetime | None = None
    flow_name: str | None = None
    run_id: str | None = None
    user_id: str | None = None
    session_id: str | None = None
    environment: str | None = None
    observation_type: str | None = None
    model: str | None = None
    tags_any: list[str] | None = None
    tags_all: list[str] | None = None
    min_cost: float | None = None
    max_cost: float | None = None
    min_latency_ms: float | None = None
    max_latency_ms: float | None = None
    has_errors: bool | None = None
    limit: int = Field(default=50, le=200)
    offset: int = Field(default=0, ge=0)
    order_by: str = "created_at"
    order_dir: str = "desc"


class MetricsQuery(BaseModel):
    project: str
    measure: str
    aggregation: str
    dimension: str | None = None
    granularity: str | None = None
    from_timestamp: datetime | None = None
    to_timestamp: datetime | None = None
    flow_name: str | None = None
    environment: str | None = None


class SearchResponse(BaseModel):
    data: list[dict[str, object]]
    total_count: int
    limit: int
    offset: int


class MetricsQueryResult(BaseModel):
    measure: str
    aggregation: str
    value: float | None
    dimension: str | None = None
    dimension_value: str | None = None


class ModelMetricsSummary(BaseModel):
    model: str
    count: int
    avg_latency_ms: float | None
    p95_latency_ms: float | None
    total_cost: float | None
    avg_cost: float | None
    total_tokens: int | None


class ProjectSummary(BaseModel):
    total_runs: int
    total_observations: int
    total_cost: float | None
    avg_latency_ms: float | None
    p95_latency_ms: float | None
    total_tokens: int | None


def _apply_trace_filters(
    statement: Any,
    f: TraceFilter,
    session: Session,
) -> Any:
    stmt = statement
    stmt = stmt.where(RunDB.project == f.project)

    if f.from_timestamp or f.to_timestamp:
        stmt = apply_date_range(stmt, RUN_CREATED_AT_COL, f.from_timestamp, f.to_timestamp)
    if f.flow_name:
        stmt = stmt.where(RunDB.flow_name == f.flow_name)
    if f.user_id:
        stmt = stmt.where(RunDB.user_id == f.user_id)
    if f.session_id:
        stmt = stmt.where(RunDB.session_id == f.session_id)
    if f.environment:
        stmt = stmt.where(RunDB.environment == f.environment)

    if f.tags_any:
        stmt = apply_tag_any_filter(stmt, f.tags_any)

    if f.tags_all:
        stmt = apply_tag_all_filter(stmt, f.tags_all)

    if f.min_cost is not None or f.max_cost is not None:
        cost_query = (
            select(LoggedCallDB.run_id)
            .where(CALL_COST_COL.is_not(None))
            .group_by(LoggedCallDB.run_id)
        )
        having_parts: list[str] = []
        if f.min_cost is not None:
            having_parts.append(f"SUM(cost) >= {f.min_cost}")
        if f.max_cost is not None:
            having_parts.append(f"SUM(cost) <= {f.max_cost}")
        if having_parts:
            cost_query = cost_query.having(sql_text(" AND ".join(having_parts)))

        matching_run_ids = session.exec(cost_query).all()
        if matching_run_ids:
            stmt = stmt.where(RUN_ID_COL.in_(matching_run_ids))
        else:
            stmt = stmt.where(sql_text("1 = 0"))

    if f.min_latency_ms is not None or f.max_latency_ms is not None:
        stmt = apply_numeric_range(stmt, RUN_DURATION_MS_COL, f.min_latency_ms, f.max_latency_ms)

    if f.has_errors is True:
        error_run_ids = session.exec(
            select(LoggedCallDB.run_id).where(CALL_LEVEL_COL == "ERROR")
        ).all()
        if error_run_ids:
            stmt = stmt.where(RUN_ID_COL.in_(error_run_ids))
        else:
            stmt = stmt.where(sql_text("1 = 0"))

    if f.min_score is not None and f.score_name:
        metric_run_ids = session.exec(
            select(RunMetricDB.run_id).where(
                RunMetricDB.metric_name == f.score_name,
                RUN_METRIC_SCORE_COL >= f.min_score,
            )
        ).all()
        if metric_run_ids:
            stmt = stmt.where(RUN_ID_COL.in_(metric_run_ids))
        else:
            stmt = stmt.where(sql_text("1 = 0"))

    return stmt


def _apply_observation_filters(statement: Any, f: ObservationFilter) -> Any:
    stmt = statement
    stmt = stmt.where(LoggedCallDB.project == f.project)

    if f.from_timestamp or f.to_timestamp:
        stmt = apply_date_range(stmt, CALL_CREATED_AT_COL, f.from_timestamp, f.to_timestamp)
    if f.flow_name:
        stmt = stmt.where(LoggedCallDB.flow_name == f.flow_name)
    if f.run_id:
        stmt = stmt.where(CALL_RUN_ID_COL == f.run_id)
    if f.user_id:
        stmt = stmt.where(LoggedCallDB.user_id == f.user_id)
    if f.session_id:
        stmt = stmt.where(LoggedCallDB.session_id == f.session_id)
    if f.environment:
        stmt = stmt.where(LoggedCallDB.environment == f.environment)
    if f.observation_type:
        stmt = stmt.where(CALL_OBSERVATION_TYPE_COL == f.observation_type.upper())
    if f.model:
        stmt = stmt.where(CALL_MODEL_COL == f.model)

    if f.tags_any:
        stmt = apply_tag_any_filter(stmt, f.tags_any)

    if f.tags_all:
        stmt = apply_tag_all_filter(stmt, f.tags_all)

    if f.min_cost is not None or f.max_cost is not None:
        stmt = apply_numeric_range(stmt, CALL_COST_COL, f.min_cost, f.max_cost)
    if f.min_latency_ms is not None or f.max_latency_ms is not None:
        stmt = apply_numeric_range(stmt, CALL_LATENCY_MS_COL, f.min_latency_ms, f.max_latency_ms)

    if f.has_errors is True:
        stmt = stmt.where(CALL_LEVEL_COL == "ERROR")

    return stmt


def _apply_ordering(
    statement: Any,
    order_by: str,
    order_dir: str,
    is_trace: bool,
) -> Any:
    if is_trace:
        col_map: dict[str, Any] = {
            "created_at": RUN_CREATED_AT_COL,
            "duration_ms": RUN_DURATION_MS_COL,
        }
    else:
        col_map = {
            "created_at": CALL_CREATED_AT_COL,
            "latency_ms": CALL_LATENCY_MS_COL,
            "cost": CALL_COST_COL,
        }

    col = col_map.get(order_by)
    if col is None:
        col = RUN_CREATED_AT_COL if is_trace else CALL_CREATED_AT_COL

    direction = desc if order_dir.lower() == "desc" else asc
    return statement.order_by(direction(col))


def _run_to_dict(run: RunDB) -> dict[str, object]:
    return {
        "id": run.id,
        "project": run.project,
        "task_id": run.task_id,
        "flow_name": run.flow_name,
        "version": run.version,
        "user_id": run.user_id,
        "session_id": run.session_id,
        "environment": run.environment,
        "external_id": run.external_id,
        "tags": run.tags,
        "primary_model": run.primary_model,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "duration_ms": run.duration_ms,
        "call_count": run.call_count,
    }


def _call_to_dict(call: LoggedCallDB) -> dict[str, object]:
    return {
        "id": call.id,
        "project": call.project,
        "task_id": call.task_id,
        "run_id": call.run_id,
        "flow_name": call.flow_name,
        "step_name": call.step_name,
        "step_index": call.step_index,
        "model": call.model,
        "latency_ms": call.latency_ms,
        "cost": call.cost,
        "observation_type": call.observation_type,
        "level": call.level,
        "status_message": call.status_message,
        "environment": call.environment,
        "tags": call.tags,
        "prompt_tokens": call.prompt_tokens,
        "completion_tokens": call.completion_tokens,
        "total_tokens": call.total_tokens,
        "provided_cost": call.provided_cost,
        "cost_breakdown": call.cost_breakdown,
        "cost_provenance": call.cost_provenance,
        "raw_usage": call.raw_usage,
        "provided_model_name": call.provided_model_name,
        "created_at": call.created_at.isoformat() if call.created_at else None,
    }


@router.post("/traces/search", response_model=SearchResponse)
async def search_traces(
    f: TraceFilter,
    session: Session = Depends(get_session),
):
    """Search traces (runs) with structured filters."""
    statement = _apply_trace_filters(select(RunDB), f, session)

    count_statement = select(func.count()).select_from(statement.subquery())
    total_count = session.exec(count_statement).one()

    statement = _apply_ordering(statement, f.order_by, f.order_dir, is_trace=True)
    statement = statement.offset(f.offset).limit(f.limit)

    runs = session.exec(statement).all()

    return SearchResponse(
        data=[_run_to_dict(run) for run in runs],
        total_count=total_count,
        limit=f.limit,
        offset=f.offset,
    )


@router.post("/observations/search", response_model=SearchResponse)
async def search_observations(
    f: ObservationFilter,
    session: Session = Depends(get_session),
):
    """Search observations (logged calls) with structured filters."""
    statement = _apply_observation_filters(select(LoggedCallDB), f)

    count_statement = select(func.count()).select_from(statement.subquery())
    total_count = session.exec(count_statement).one()

    statement = _apply_ordering(statement, f.order_by, f.order_dir, is_trace=False)
    statement = statement.offset(f.offset).limit(f.limit)

    calls = session.exec(statement).all()

    return SearchResponse(
        data=[_call_to_dict(call) for call in calls],
        total_count=total_count,
        limit=f.limit,
        offset=f.offset,
    )


def _build_metrics_where(query: MetricsQuery) -> list[Any]:
    conditions: list[Any] = [LoggedCallDB.project == query.project]
    if query.from_timestamp:
        conditions.append(CALL_CREATED_AT_COL >= query.from_timestamp)
    if query.to_timestamp:
        conditions.append(CALL_CREATED_AT_COL <= query.to_timestamp)
    if query.flow_name:
        conditions.append(LoggedCallDB.flow_name == query.flow_name)
    if query.environment:
        conditions.append(LoggedCallDB.environment == query.environment)
    return conditions


def _get_measure_col(measure: str) -> Any:
    return getattr(LoggedCallDB, measure, LoggedCallDB.latency_ms)


def _get_dimension_col(dimension: str) -> Any:
    if dimension == "date":
        return func.strftime("%Y-%m-%d", CALL_CREATED_AT_COL)
    return getattr(LoggedCallDB, dimension, CALL_MODEL_COL)


@router.post("/metrics/query", response_model=list[MetricsQueryResult])
async def query_metrics(
    query: MetricsQuery,
    session: Session = Depends(get_session),
):
    """Aggregate metrics query with optional dimension grouping."""
    if query.dimension is not None:
        return _query_metrics_with_dimension(query, session)

    measure_col = _get_measure_col(query.measure)
    where = _build_metrics_where(query)
    agg = query.aggregation.lower()

    if agg in ("sum", "avg", "count"):
        sql_func_map: dict[str, Any] = {
            "sum": func.sum,
            "avg": func.avg,
            "count": func.count,
        }
        result = session.exec(
            select(sql_func_map[agg](measure_col)).where(*where)
        ).one()
        return [MetricsQueryResult(
            measure=query.measure,
            aggregation=query.aggregation,
            value=float(result) if result is not None else None,
        )]

    raw_values = session.exec(
        select(measure_col).where(*where, measure_col.is_not(None))
    ).all()
    values = [float(v) for v in raw_values if v is not None]

    if not values:
        return [MetricsQueryResult(
            measure=query.measure,
            aggregation=query.aggregation,
            value=None,
        )]

    return [MetricsQueryResult(
        measure=query.measure,
        aggregation=query.aggregation,
        value=compute_aggregate(values, query.aggregation),
    )]


def _query_metrics_with_dimension(
    query: MetricsQuery,
    session: Session,
) -> list[MetricsQueryResult]:
    dimension = query.dimension or "model"
    measure_col = _get_measure_col(query.measure)
    dim_col = _get_dimension_col(dimension)
    where = _build_metrics_where(query)
    agg = query.aggregation.lower()

    if agg in ("sum", "avg", "count"):
        sql_func_map: dict[str, Any] = {
            "sum": func.sum,
            "avg": func.avg,
            "count": func.count,
        }
        rows = session.exec(
            select(dim_col, sql_func_map[agg](measure_col))
            .where(*where, dim_col.is_not(None))
            .group_by(dim_col)
        ).all()
        results: list[MetricsQueryResult] = []
        for row in rows:
            results.append(MetricsQueryResult(
                measure=query.measure,
                aggregation=query.aggregation,
                value=float(row[1]) if row[1] is not None else None,
                dimension=dimension,
                dimension_value=str(row[0]) if row[0] is not None else None,
            ))
        if not results:
            return [MetricsQueryResult(
                measure=query.measure,
                aggregation=query.aggregation,
                value=None,
                dimension=dimension,
                dimension_value=None,
            )]
        return sorted(results, key=lambda r: r.dimension_value or "")

    raw_pairs = session.exec(
        select(dim_col, measure_col)
        .where(*where, dim_col.is_not(None), measure_col.is_not(None))
    ).all()

    groups: dict[str, list[float]] = {}
    for row in raw_pairs:
        dim_val = row[0]
        val = row[1]
        key = str(dim_val) if dim_val is not None else None
        if key is not None and val is not None:
            groups.setdefault(key, []).append(float(val))

    if not groups:
        return [MetricsQueryResult(
            measure=query.measure,
            aggregation=query.aggregation,
            value=None,
            dimension=dimension,
            dimension_value=None,
        )]

    results = []
    for dim_val, vals in sorted(groups.items()):
        results.append(MetricsQueryResult(
            measure=query.measure,
            aggregation=query.aggregation,
            value=compute_aggregate(vals, query.aggregation),
            dimension=dimension,
            dimension_value=dim_val,
        ))

    return results


@router.get("/metrics/models", response_model=list[ModelMetricsSummary])
async def get_model_metrics(
    project: str,
    environment: str | None = None,
    session: Session = Depends(get_session),
):
    """Per-model metrics summary."""
    base_where: list[Any] = [LoggedCallDB.project == project]
    if environment:
        base_where.append(LoggedCallDB.environment == environment)

    agg_rows = session.execute(
        sa_select(
            CALL_MODEL_COL,
            func.count(),
            func.avg(CALL_LATENCY_MS_COL),
            func.sum(CALL_COST_COL),
            func.avg(CALL_COST_COL),
            func.sum(CALL_TOTAL_TOKENS_COL),
        )
        .where(*base_where)
        .group_by(CALL_MODEL_COL)
    ).all()

    latency_rows = session.exec(
        select(LoggedCallDB.model, CALL_LATENCY_MS_COL)
        .where(*base_where, CALL_LATENCY_MS_COL.is_not(None))
    ).all()
    latencies_by_model: dict[str, list[float]] = {}
    for row in latency_rows:
        model = row[0]
        lat = row[1]
        if model is not None and lat is not None:
            latencies_by_model.setdefault(model, []).append(float(lat))

    results: list[ModelMetricsSummary] = []
    for row in sorted(agg_rows, key=lambda r: r[0] or ""):
        model = row[0]
        model_latencies = latencies_by_model.get(model, [])
        results.append(ModelMetricsSummary(
            model=model,
            count=row[1],
            avg_latency_ms=row[2] if row[2] is not None else None,
            p95_latency_ms=compute_percentile(model_latencies, 95) if model_latencies else None,
            total_cost=row[3] if row[3] is not None else None,
            avg_cost=row[4] if row[4] is not None else None,
            total_tokens=row[5] if row[5] is not None else None,
        ))

    return results


@router.get("/metrics/summary", response_model=ProjectSummary)
async def get_project_summary(
    project: str,
    environment: str | None = None,
    session: Session = Depends(get_session),
):
    """Project-level metrics summary."""
    run_where: list[Any] = [RunDB.project == project]
    if environment:
        run_where.append(RunDB.environment == environment)
    total_runs = session.exec(
        select(func.count()).select_from(RunDB).where(*run_where)
    ).one()

    call_where: list[Any] = [LoggedCallDB.project == project]
    if environment:
        call_where.append(LoggedCallDB.environment == environment)

    agg_row = session.exec(
        select(
            func.count(),
            func.sum(CALL_COST_COL),
            func.avg(CALL_LATENCY_MS_COL),
            func.sum(CALL_TOTAL_TOKENS_COL),
        ).where(*call_where)
    ).one()

    latency_values = [
        float(v) for v in session.exec(
            select(CALL_LATENCY_MS_COL).where(
                *call_where, CALL_LATENCY_MS_COL.is_not(None)
            )
        ).all() if v is not None
    ]

    return ProjectSummary(
        total_runs=total_runs,
        total_observations=agg_row[0],
        total_cost=agg_row[1] if agg_row[1] is not None else None,
        avg_latency_ms=agg_row[2] if agg_row[2] is not None else None,
        p95_latency_ms=compute_percentile(latency_values, 95) if latency_values else None,
        total_tokens=agg_row[3] if agg_row[3] is not None else None,
    )
