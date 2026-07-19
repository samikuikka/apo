# pyright: reportCallInDefaultInitializer=false, reportDeprecated=false, reportAny=false

from datetime import datetime, timedelta
from typing import cast

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import SQLModel, Session

from ..db import get_session
from ..db_helpers import _as_column
from ..models import RunMetricDB, RunDB


router = APIRouter(prefix="/v1/metrics-analytics", tags=["metrics-analytics"])


RUN_ID_COL: ColumnElement[str] = _as_column(cast(object, RunDB.id))
RUN_PROJECT_COL: ColumnElement[str] = _as_column(cast(object, RunDB.project))
RUN_METRIC_ID_COL: ColumnElement[int] = _as_column(cast(object, RunMetricDB.id))
RUN_METRIC_RUN_ID_COL: ColumnElement[str] = _as_column(cast(object, RunMetricDB.run_id))
RUN_METRIC_PROJECT_COL: ColumnElement[str] = _as_column(cast(object, RunMetricDB.project))
RUN_METRIC_NAME_COL: ColumnElement[str] = _as_column(cast(object, RunMetricDB.metric_name))
RUN_METRIC_SCORE_COL: ColumnElement[float] = _as_column(cast(object, RunMetricDB.score))
RUN_METRIC_SOURCE_COL: ColumnElement[str] = _as_column(cast(object, RunMetricDB.source))
RUN_METRIC_CREATED_AT_COL: ColumnElement[datetime] = _as_column(
    cast(object, RunMetricDB.created_at)
)


class MetricTrendPoint(SQLModel):
    """A single point in a metric trend."""
    date: str
    avg_score: float
    count: int
    min_score: float
    max_score: float


class MetricSummary(SQLModel):
    """Summary statistics for a metric."""
    metric_name: str
    avg_score: float | None
    count: int
    p50: float | None
    p90: float | None
    p95: float | None
    p99: float | None
    min_score: float | None
    max_score: float | None


class MetricSourceStats(SQLModel):
    count: int
    avg_score: float | None


class MetricsBySource(SQLModel):
    count: int
    metrics: dict[str, MetricSourceStats]


@router.get("/trends", response_model=list[MetricTrendPoint])
def get_metric_trends(
    project: str,
    metric_name: str,
    days: int = Query(30, ge=1, le=365, description="Number of days to look back"),
    session: Session = Depends(get_session)
) -> list[MetricTrendPoint]:
    """
    Get metric scores over time (daily aggregates).

    Useful for tracking:
    - How a metric improves/degrades over time
    - Impact of prompt changes
    - Regression detection

    Args:
        project: Project identifier
        metric_name: Name of the metric to analyze
        days: Number of days to look back (1-365)
    """
    cutoff_date = datetime.utcnow() - timedelta(days=days)

    # Build query with date truncation
    query = (
        session.query(
            func.date(RUN_METRIC_CREATED_AT_COL).label("date"),
            func.avg(RUN_METRIC_SCORE_COL).label("avg_score"),
            func.count(RUN_METRIC_ID_COL).label("count"),
            func.min(RUN_METRIC_SCORE_COL).label("min_score"),
            func.max(RUN_METRIC_SCORE_COL).label("max_score"),
        )
        .join(RunDB, RUN_METRIC_RUN_ID_COL == RUN_ID_COL)
        .where(
            RUN_PROJECT_COL == project,
            RUN_METRIC_PROJECT_COL == project,
            RUN_METRIC_NAME_COL == metric_name,
            RUN_METRIC_SCORE_COL.isnot(None),
            RUN_METRIC_CREATED_AT_COL >= cutoff_date
        )
    )

    query = query.group_by(func.date(RUN_METRIC_CREATED_AT_COL))
    query = query.order_by(func.date(RUN_METRIC_CREATED_AT_COL))

    results = query.all()

    return [
        MetricTrendPoint(
            date=str(row.date),
            avg_score=float(row.avg_score) if row.avg_score else 0.0,
            count=int(row.count),
            min_score=float(row.min_score) if row.min_score else 0.0,
            max_score=float(row.max_score) if row.max_score else 0.0,
        )
        for row in results
    ]


@router.get("/summary", response_model=list[MetricSummary])
def get_metrics_summary(
    project: str,
    session: Session = Depends(get_session)
) -> list[MetricSummary]:
    """
    Get summary statistics for all metrics in a project.

    Includes percentiles (p50, p90, p95, p99) for distribution analysis.

    Args:
        project: Project identifier
    """
    # Get all unique metric names for this project
    subquery = (
        session.query(RUN_METRIC_NAME_COL)
        .join(RunDB, RUN_METRIC_RUN_ID_COL == RUN_ID_COL)
        .where(RUN_PROJECT_COL == project, RUN_METRIC_PROJECT_COL == project)
        .distinct()
    )

    metric_names = [row[0] for row in subquery.all()]

    summaries: list[MetricSummary] = []
    for metric_name in metric_names:
        # Get all scores for this metric
        query = (
            session.query(RUN_METRIC_SCORE_COL)
            .join(RunDB, RUN_METRIC_RUN_ID_COL == RUN_ID_COL)
            .where(
                RUN_PROJECT_COL == project,
                RUN_METRIC_PROJECT_COL == project,
                RUN_METRIC_NAME_COL == metric_name,
                RUN_METRIC_SCORE_COL.isnot(None)
            )
        )

        scores = [float(row[0]) for row in query.all()]

        if not scores:
            continue

        scores.sort()
        count = len(scores)

        # Calculate percentiles
        def percentile(p: float) -> float:
            idx = int(count * p / 100)
            return scores[idx] if idx < count else scores[-1]

        summaries.append(
            MetricSummary(
                metric_name=metric_name,
                avg_score=sum(scores) / count,
                count=count,
                p50=percentile(50),
                p90=percentile(90),
                p95=percentile(95),
                p99=percentile(99),
                min_score=scores[0],
                max_score=scores[-1],
            )
        )

    return summaries


@router.get("/by-source")
def get_metrics_by_source(
    project: str,
    metric_name: str | None = None,
    days: int = Query(30, ge=1, le=365),
    session: Session = Depends(get_session)
) -> dict[str, MetricsBySource]:
    """
    Get metrics breakdown by source (ANNOTATION, API, EVAL).

    Useful for understanding the mix of human vs automated evaluations.

    Args:
        project: Project identifier
        metric_name: Optional metric filter
        days: Number of days to look back
    """
    cutoff_date = datetime.utcnow() - timedelta(days=days)

    query = (
        session.query(
            RUN_METRIC_SOURCE_COL.label("source"),
            RUN_METRIC_NAME_COL.label("metric_name"),
            func.count(RUN_METRIC_ID_COL).label("count"),
            func.avg(RUN_METRIC_SCORE_COL).label("avg_score"),
        )
        .join(RunDB, RUN_METRIC_RUN_ID_COL == RUN_ID_COL)
        .where(
            RUN_PROJECT_COL == project,
            RUN_METRIC_PROJECT_COL == project,
            RUN_METRIC_CREATED_AT_COL >= cutoff_date
        )
    )

    if metric_name:
        query = query.where(RUN_METRIC_NAME_COL == metric_name)

    query = query.group_by(RUN_METRIC_SOURCE_COL, RUN_METRIC_NAME_COL)

    results = query.all()

    # Group by source
    output: dict[str, MetricsBySource] = {
        "ANNOTATION": MetricsBySource(count=0, metrics={}),
        "API": MetricsBySource(count=0, metrics={}),
        "EVAL": MetricsBySource(count=0, metrics={}),
    }

    for row in results:
        source = row.source
        metric = row.metric_name

        if source not in output:
            output[source] = MetricsBySource(count=0, metrics={})

        output[source].count += int(row.count)
        output[source].metrics[metric] = MetricSourceStats(
            count=int(row.count),
            avg_score=float(row.avg_score) if row.avg_score else None,
        )

    return output
