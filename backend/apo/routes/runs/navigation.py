# pyright: reportCallInDefaultInitializer=false

from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import asc, desc
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, col, select

from ...db import get_session
from ...db_helpers import _as_column
from ...models import RunDB

router = APIRouter(prefix="/v1/runs", tags=["runs"])


RUN_ID_COL: ColumnElement[str] = _as_column(cast(object, RunDB.id))
RUN_PROJECT_COL: ColumnElement[str] = _as_column(cast(object, RunDB.project))
RUN_CREATED_AT_COL: ColumnElement[object] = _as_column(cast(object, RunDB.created_at))
RUN_DURATION_MS_COL: ColumnElement[object] = _as_column(cast(object, RunDB.duration_ms))
RUN_CALL_COUNT_COL: ColumnElement[object] = _as_column(cast(object, RunDB.call_count))


class AdjacentRuns(BaseModel):
    prev_id: str | None
    next_id: str | None


VALID_NAV_SORT_FIELDS = {"created_at", "duration_ms", "call_count"}


def _get_nav_sort_column(field: str) -> ColumnElement[object]:
    if field == "duration_ms":
        return RUN_DURATION_MS_COL
    if field == "call_count":
        return RUN_CALL_COUNT_COL
    return RUN_CREATED_AT_COL


@router.get("/{run_id}/adjacent", response_model=AdjacentRuns)
def get_adjacent_runs(
    run_id: str,
    project: str = "default",
    sort_by: str = Query("created_at", description="Sort field"),
    sort_order: str = Query("desc", description="Sort direction: asc or desc"),
    session: Session = Depends(get_session),
) -> AdjacentRuns:
    """Return the previous and next run IDs relative to the given run in the sort order."""
    run = session.exec(
        select(RunDB).where(
            RunDB.id == run_id, col(RunDB.project) == project
        )
    ).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    sort_field = sort_by if sort_by in VALID_NAV_SORT_FIELDS else "created_at"
    sort_col = _get_nav_sort_column(sort_field)
    is_desc = sort_order == "desc"

    current_value = getattr(run, sort_field)

    if is_desc:
        prev_stmt = (
            select(RUN_ID_COL)
            .where(RUN_PROJECT_COL == project, sort_col < current_value)
            .order_by(desc(sort_col))
            .limit(1)
        )
        next_stmt = (
            select(RUN_ID_COL)
            .where(RUN_PROJECT_COL == project, sort_col > current_value)
            .order_by(asc(sort_col))
            .limit(1)
        )
    else:
        prev_stmt = (
            select(RUN_ID_COL)
            .where(RUN_PROJECT_COL == project, sort_col > current_value)
            .order_by(asc(sort_col))
            .limit(1)
        )
        next_stmt = (
            select(RUN_ID_COL)
            .where(RUN_PROJECT_COL == project, sort_col < current_value)
            .order_by(desc(sort_col))
            .limit(1)
        )

    prev_result = session.execute(prev_stmt).scalar_one_or_none()
    next_result = session.execute(next_stmt).scalar_one_or_none()

    return AdjacentRuns(prev_id=prev_result, next_id=next_result)
