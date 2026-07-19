# pyright: reportCallInDefaultInitializer=false, reportPrivateUsage=false

from typing import cast

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import asc
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, col, select

from ..db import get_session
from ..db_helpers import _as_column
from ..models import (
    LoggedCall,
    LoggedCallDB,
    Run,
    RunDB,
    RunDetail,
    RunMetric,
    RunMetricDB,
)
from ..services.demo_workspace import require_run_not_demo
from .runs.metrics import calculate_run_metrics_from_calls

router = APIRouter(tags=["public"])

LOGGED_CALL_STEP_INDEX_COL: ColumnElement[int | None] = _as_column(
    cast(object, LoggedCallDB.step_index)
)
LOGGED_CALL_CREATED_AT_COL: ColumnElement[object] = _as_column(
    cast(object, LoggedCallDB.created_at)
)
LOGGED_CALL_RUN_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, LoggedCallDB.run_id)
)
RUN_METRIC_RUN_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunMetricDB.run_id)
)
RUN_METRIC_PROJECT_COL: ColumnElement[str] = _as_column(
    cast(object, RunMetricDB.project)
)


@router.get("/public/traces/{run_id}")
def get_public_trace(
    run_id: str,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Get a published trace without authentication.

    ``project`` resolves the right trace when two Projects publish the same OTel
    id (SPEC-133 M4). Defaults to ``"default"`` for legacy share URLs.
    """
    run = session.exec(
        select(RunDB).where(RunDB.id == run_id, RunDB.project == project)
    ).first()
    if not run or not run.is_public:
        raise HTTPException(status_code=404, detail="Trace not found or not public")

    calls = session.exec(
        select(LoggedCallDB)
        .where(
            LoggedCallDB.run_id == run_id,
            col(LoggedCallDB.project) == project,
        )
        .order_by(
            asc(LOGGED_CALL_STEP_INDEX_COL).nulls_last(),
            asc(LOGGED_CALL_CREATED_AT_COL),
        )
    ).all()

    stored_metrics = session.exec(
        select(RunMetricDB).where(
            RUN_METRIC_RUN_ID_COL == run_id,
            RUN_METRIC_PROJECT_COL == project,
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


@router.patch("/v1/runs/{run_id}/visibility")
def toggle_visibility(
    run_id: str,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Toggle public visibility for a run."""
    run = require_run_not_demo(session, run_id, project)

    run.is_public = not run.is_public
    session.commit()
    session.refresh(run)

    return {"id": run.id, "is_public": run.is_public}
