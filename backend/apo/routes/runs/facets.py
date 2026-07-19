# pyright: reportCallInDefaultInitializer=false

from typing import Any, cast

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, or_, text
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, select

from ...db import get_session
from ...db_helpers import _as_column
from ...models import LoggedCallDB, RunDB, RunMetricDB
from ...models.schemas import FacetBucket, RunFacets
from ...services.filters import apply_date_range, apply_tag_filters

router = APIRouter(prefix="/v1/runs", tags=["runs"])

RUN_ID_COL: ColumnElement[str] = _as_column(cast(object, RunDB.id))
RUN_PRIMARY_MODEL_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunDB.primary_model)
)
RUN_ENVIRONMENT_COL: ColumnElement[str] = _as_column(cast(object, RunDB.environment))
RUN_USER_ID_COL: ColumnElement[str | None] = _as_column(cast(object, RunDB.user_id))
RUN_SESSION_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, RunDB.session_id)
)
RUN_CALL_COUNT_COL: ColumnElement[int] = _as_column(
    cast(object, RunDB.call_count)
)
CALL_RUN_ID_COL: ColumnElement[str | None] = _as_column(
    cast(object, LoggedCallDB.run_id)
)
CALL_LEVEL_COL: ColumnElement[str | None] = _as_column(
    cast(object, LoggedCallDB.level)
)
CALL_MODEL_COL: ColumnElement[str] = _as_column(cast(object, LoggedCallDB.model))
METRIC_RUN_ID_COL: ColumnElement[str] = _as_column(
    cast(object, RunMetricDB.run_id)
)
METRIC_NAME_COL: ColumnElement[str] = _as_column(
    cast(object, RunMetricDB.metric_name)
)


def _split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [v.strip() for v in value.split(",") if v.strip()]


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
) -> list[str]:
    stmt = select(RUN_ID_COL)
    if project:
        stmt = stmt.where(RunDB.project == project)

    model_list = _split_csv(models)
    if model_list:
        call_model_ids = select(CALL_RUN_ID_COL).where(
            CALL_RUN_ID_COL.is_not(None),
            CALL_MODEL_COL.in_(model_list),
        )
        stmt = stmt.where(
            or_(
                RUN_PRIMARY_MODEL_COL.in_(model_list),
                RUN_ID_COL.in_(call_model_ids),
            )
        )

    env_list = _split_csv(environment)
    if env_list:
        stmt = stmt.where(RUN_ENVIRONMENT_COL.in_(env_list))

    user_list = _split_csv(user_id)
    if user_list:
        stmt = stmt.where(RUN_USER_ID_COL.in_(user_list))

    session_list = _split_csv(session_id)
    if session_list:
        stmt = stmt.where(RUN_SESSION_ID_COL.in_(session_list))

    if tags:
        stmt = apply_tag_filters(stmt, tags)
    if metric_name:
        metric_run_ids = select(METRIC_RUN_ID_COL).where(
            METRIC_NAME_COL == metric_name
        )
        stmt = stmt.where(RUN_ID_COL.in_(metric_run_ids))
    if created_after or created_before:
        stmt = apply_date_range(stmt, RunDB.created_at, created_after, created_before)

    status_values = _split_csv(status)
    if status_values:
        conditions: list[Any] = []
        if "error" in status_values:
            error_sub = select(CALL_RUN_ID_COL).where(
                CALL_RUN_ID_COL.is_not(None),
                CALL_LEVEL_COL == "ERROR",
            )
            conditions.append(RUN_ID_COL.in_(error_sub))
        if "warning" in status_values:
            warning_sub = select(CALL_RUN_ID_COL).where(
                CALL_RUN_ID_COL.is_not(None),
                CALL_LEVEL_COL == "WARNING",
            )
            error_sub = select(CALL_RUN_ID_COL).where(
                CALL_RUN_ID_COL.is_not(None),
                CALL_LEVEL_COL == "ERROR",
            )
            conditions.append(
                and_(RUN_ID_COL.in_(warning_sub), RUN_ID_COL.not_in(error_sub))
            )
        if "success" in status_values:
            issues_sub = select(CALL_RUN_ID_COL).where(
                CALL_RUN_ID_COL.is_not(None),
                CALL_LEVEL_COL.in_(["ERROR", "WARNING"]),
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
        select(CALL_MODEL_COL, func.count(func.distinct(CALL_RUN_ID_COL)))
        .where(CALL_RUN_ID_COL.in_(run_ids))
        .group_by(CALL_MODEL_COL)
        .order_by(func.count(func.distinct(CALL_RUN_ID_COL)).desc())
    )
    rows = session.exec(stmt).all()
    return [FacetBucket(value=r[0], count=r[1]) for r in rows if r[0]]


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
        select(METRIC_NAME_COL, func.count(func.distinct(METRIC_RUN_ID_COL)))
        .where(METRIC_RUN_ID_COL.in_(run_ids))
        .group_by(METRIC_NAME_COL)
        .order_by(func.count(func.distinct(METRIC_RUN_ID_COL)).desc())
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
            select(CALL_RUN_ID_COL).where(
                CALL_RUN_ID_COL.in_(run_ids),
                CALL_LEVEL_COL == "ERROR",
            )
        ).all()
    )
    warning_ids = set(
        session.exec(
            select(CALL_RUN_ID_COL).where(
                CALL_RUN_ID_COL.in_(run_ids),
                CALL_LEVEL_COL == "WARNING",
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
    all_kwargs: dict[str, str | None] = dict(
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
    )

    def filtered_ids(**overrides: str | None) -> list[str]:
        kw = {**all_kwargs, **overrides}
        return _build_filtered_run_ids(session=session, **kw)

    return RunFacets(
        status=_compute_status_facets(
            session, filtered_ids(status=None) if status else filtered_ids()
        ),
        models=_compute_model_facets(
            session, filtered_ids(models=None) if models else filtered_ids()
        ),
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
