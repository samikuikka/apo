# pyright: reportAny=false, reportExplicitAny=false, reportUnusedCallResult=false

"""Project-scoped predicates that tie a run to its dependent rows.

``logged_calls`` and ``run_metrics`` hold every tenant's rows, and a trace id
is unique only within one project (a demo copy shares its ids with the
original). So "this run has an ERROR call" has to mean a call of the run's
own project. The traces list and its facets build their status, model, and
metric filters from the predicates here, so that rule is written once.

The shape of each subquery matters as much as its predicate:

- Uncorrelated, so the database evaluates it once per statement. A subquery
  correlated on ``runs.project`` is re-run for every outer row whenever the
  project is not pinned to a constant.
- The project predicate sits inside the subquery, so the planner can seek a
  project-led index. A subquery on ``level`` or ``model`` alone has no
  project to seek on and walks the whole table, or a whole index, across
  every tenant.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, or_, select, tuple_
from sqlalchemy.sql.elements import ColumnElement

from ...models.columns import (
    LOGGED_CALL_LEVEL_COL,
    LOGGED_CALL_MODEL_COL,
    LOGGED_CALL_PROJECT_COL,
    LOGGED_CALL_RUN_ID_COL,
    RUN_CALL_COUNT_COL,
    RUN_ID_COL,
    RUN_METRIC_PROJECT_COL,
    RUN_METRIC_RUN_ID_COL,
    RUN_PRIMARY_MODEL_COL,
    RUN_PROJECT_COL,
)


@dataclass(frozen=True)
class RunScope:
    """Which projects a run query may read.

    One pinned ``project`` (every dashboard request), else the caller's
    membership list in ``allowed_projects``, else neither: dev/open mode,
    where the membership system is off and every project is readable.
    """

    project: str | None = None
    allowed_projects: Sequence[str] | None = None


@dataclass(frozen=True)
class RunStatusConditions:
    """The three run statuses as predicates on the outer ``runs`` row."""

    error: ColumnElement[bool]
    warning: ColumnElement[bool]
    success: ColumnElement[bool]


def scope_runs(statement: Any, scope: RunScope) -> Any:
    """Restrict a statement over ``runs`` to the scope's projects."""
    if scope.project:
        return statement.where(RUN_PROJECT_COL == scope.project)
    if scope.allowed_projects is not None:
        return statement.where(RUN_PROJECT_COL.in_(scope.allowed_projects))
    return statement


def runs_with_calls(scope: RunScope, *conditions: Any) -> ColumnElement[bool]:
    """The outer run has a call, in its own project, matching ``conditions``."""
    return _run_key(scope).in_(_rows_in_scope(scope, _CALLS, conditions))


def runs_without_calls(scope: RunScope, *conditions: Any) -> ColumnElement[bool]:
    """The outer run has no call, in its own project, matching ``conditions``."""
    return _run_key(scope).not_in(_rows_in_scope(scope, _CALLS, conditions))


def metric_runs(scope: RunScope, *conditions: Any) -> Any:
    """SELECT of the run keys that own a metric matching ``conditions``."""
    return _rows_in_scope(scope, _METRICS, conditions)


def runs_with_metrics(scope: RunScope, *conditions: Any) -> ColumnElement[bool]:
    """The outer run has a metric, in its own project, matching ``conditions``."""
    return _run_key(scope).in_(metric_runs(scope, *conditions))


def calls_of_runs(scope: RunScope, runs: Any) -> list[ColumnElement[bool]]:
    """Predicates keeping the calls that belong to the given ``runs`` SELECT."""
    return _rows_of_runs(scope, _CALLS, runs)


def metrics_of_runs(scope: RunScope, runs: Any) -> list[ColumnElement[bool]]:
    """Predicates keeping the metrics that belong to the given ``runs`` SELECT."""
    return _rows_of_runs(scope, _METRICS, runs)


def calls_of_page_rows(
    scope: RunScope, rows: Sequence[tuple[str, str]]
) -> ColumnElement[bool]:
    """Calls of exactly these ``(run_id, project)`` page rows."""
    return _rows_of_page(scope, _CALLS, rows)


def metrics_of_page_rows(
    scope: RunScope, rows: Sequence[tuple[str, str]]
) -> ColumnElement[bool]:
    """Metrics of exactly these ``(run_id, project)`` page rows."""
    return _rows_of_page(scope, _METRICS, rows)


def status_conditions(scope: RunScope) -> RunStatusConditions:
    """Run status as the list derives it from call levels.

    ``error`` wins over ``warning``; ``success`` needs at least one call, so
    a run that recorded nothing has no status at all.
    """
    is_error = LOGGED_CALL_LEVEL_COL == "ERROR"
    is_warning = LOGGED_CALL_LEVEL_COL == "WARNING"
    is_issue = LOGGED_CALL_LEVEL_COL.in_(("ERROR", "WARNING"))
    return RunStatusConditions(
        error=runs_with_calls(scope, is_error),
        warning=and_(
            runs_with_calls(scope, is_warning), runs_without_calls(scope, is_error)
        ),
        success=and_(runs_without_calls(scope, is_issue), RUN_CALL_COUNT_COL > 0),
    )


def status_predicate(
    scope: RunScope, status_values: Sequence[str]
) -> ColumnElement[bool] | None:
    """Runs in any of the requested statuses; ``None`` when none is known."""
    conditions = status_conditions(scope)
    selected = [
        condition
        for name, condition in (
            ("error", conditions.error),
            ("warning", conditions.warning),
            ("success", conditions.success),
        )
        if name in status_values
    ]
    return or_(*selected) if selected else None


def model_predicate(scope: RunScope, models: Sequence[str]) -> ColumnElement[bool]:
    """Runs whose primary model, or any of their own calls, used a model."""
    return or_(
        RUN_PRIMARY_MODEL_COL.in_(models),
        runs_with_calls(scope, LOGGED_CALL_MODEL_COL.in_(models)),
    )


@dataclass(frozen=True)
class _Dependent:
    """A table whose rows point at a run by ``(run_id, project)``."""

    run_id: ColumnElement[Any]
    project: ColumnElement[Any]


_CALLS = _Dependent(LOGGED_CALL_RUN_ID_COL, LOGGED_CALL_PROJECT_COL)
_METRICS = _Dependent(RUN_METRIC_RUN_ID_COL, RUN_METRIC_PROJECT_COL)


def _run_key(scope: RunScope) -> ColumnElement[Any]:
    # A pinned project makes the trace id exact, and a scalar IN lets the
    # planner probe one materialized list. Without a pin the id alone is
    # ambiguous, so a run is matched on (id, project).
    if scope.project:
        return RUN_ID_COL
    return tuple_(RUN_ID_COL, RUN_PROJECT_COL)


def _rows_in_scope(scope: RunScope, table: _Dependent, conditions: Sequence[Any]) -> Any:
    key = [table.run_id] if scope.project else [table.run_id, table.project]
    return select(*key).where(
        # NOT IN against a list holding NULL is never true: one row without a
        # run would empty every negative filter.
        table.run_id.is_not(None),
        *_project_predicates(scope, table.project),
        *conditions,
    )


def _rows_of_runs(scope: RunScope, table: _Dependent, runs: Any) -> list[ColumnElement[bool]]:
    if scope.project:
        belongs = table.run_id.in_(runs.with_only_columns(RUN_ID_COL))
    else:
        belongs = tuple_(table.run_id, table.project).in_(
            runs.with_only_columns(RUN_ID_COL, RUN_PROJECT_COL)
        )
    return [*_project_predicates(scope, table.project), belongs]


def _rows_of_page(
    scope: RunScope, table: _Dependent, rows: Sequence[tuple[str, str]]
) -> ColumnElement[bool]:
    # Hydration holds the page's run rows, not a SELECT over them. Same key
    # rule as _rows_of_runs: a pinned project makes the trace id exact, so a
    # scalar IN probes one materialized list; without a pin the id alone is
    # ambiguous across projects and the (run_id, project) pair decides.
    if scope.project:
        return and_(
            table.run_id.in_([run_id for run_id, _project in rows]),
            *_project_predicates(scope, table.project),
        )
    return tuple_(table.run_id, table.project).in_(rows)


def _project_predicates(
    scope: RunScope, project: ColumnElement[Any]
) -> list[ColumnElement[bool]]:
    if scope.project:
        return [project == scope.project]
    if scope.allowed_projects is not None:
        return [project.in_(scope.allowed_projects)]
    return []
