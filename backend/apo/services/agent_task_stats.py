"""Aggregation of agent-task runs into stats summaries.

Single source of truth for the per-task / per-project roll-up used by both
the project-scoped and discovery-scoped routes. Previously this computation
was duplicated (and kept in sync by a docstring promise) across
``routes/projects.py`` and ``routes/agent_task_runs.py``; both now delegate
here so the numbers cannot drift.

Performance contract: the loader (``load_run_stat_fields``) SELECTs only the
scalar columns + ``checks_json`` that aggregation reads. It deliberately does
NOT fetch ``transcript_json`` / ``deliverables_json`` — those JSON blobs can
be MBs per row and loading them for every historical run caused the backend
to be OOM-killed on the task list page in production. ``RunStatFields`` is
the explicit minimal shape, so the cost cannot silently regress: there is no
attribute on it that *could* hold a transcript.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import cast

from sqlalchemy import desc, select as sa_select
from sqlmodel import Session
from sqlalchemy.sql.elements import ColumnElement

from ..db_helpers import _as_column
from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from ..models.schemas import AgentTaskRunStats, RunConfigEffortFacet, RunConfigModelFacet


@dataclass(frozen=True, slots=True)
class RunStatFields:
    """The minimal slice of a task run that stats aggregation reads.

    This exists so the query feeding ``compute_run_stats`` can project only
    these columns. There is intentionally no ``id``, ``task_path``, and —
    crucially — no ``checks_json`` / ``transcript_json`` / ``deliverables_json``
    here: the stats math does not need the evidence document, and pulling it
    for thousands of historical rows OOM-kills the backend. The verdict was moved onto the row as scalars, so stats now sums two ints per run instead
    of loading and iterating the check document.
    """

    status: str
    started_at: datetime | None
    completed_at: datetime | None
    total_cost: float | None
    pass_result: bool | None
    total_checks: int
    passed_checks: int


def compute_run_stats(runs: Sequence[RunStatFields]) -> AgentTaskRunStats:
    """Aggregate a set of task runs into a stats summary.

    Handles an empty list (returns all-zero / None fields). Callers that
    already guard against empty input get the same result either way.
    """
    total = len(runs)

    completed = [r for r in runs if r.completed_at and r.started_at]
    durations: list[float] = []
    for run in completed:
        assert run.completed_at is not None and run.started_at is not None
        ms = (run.completed_at - run.started_at).total_seconds() * 1000
        if ms >= 0:
            durations.append(ms)

    passed = sum(1 for r in runs if r.status == "passed")
    failed = sum(1 for r in runs if r.status == "failed")
    errored = sum(1 for r in runs if r.status == "error")

    # sum the persisted scalar verdict columns.
    total_checks = sum(r.total_checks for r in runs)
    passed_checks = sum(r.passed_checks for r in runs)

    costs = [r.total_cost for r in runs if r.total_cost is not None]
    latest = runs[0] if runs else None

    return AgentTaskRunStats(
        total_runs=total,
        passed_runs=passed,
        failed_runs=failed,
        errored_runs=errored,
        pass_rate=round(passed / total, 2) if total > 0 else 0.0,
        avg_duration_ms=round(sum(durations) / len(durations)) if durations else None,
        last_run_at=latest.started_at if latest else None,
        last_run_status=latest.status if latest else None,
        last_run_passed=latest.pass_result if latest else None,
        total_checks=total_checks,
        checks_pass_rate=round(passed_checks / total_checks, 2)
        if total_checks > 0
        else 0.0,
        avg_cost=round(sum(costs) / len(costs), 4) if costs else None,
    )


def load_run_stat_fields(
    session: Session,
    project_id: str,
    task_ids: list[str],
    model: str | None = None,
    effort: str | None = None,
) -> dict[str, list[RunStatFields]]:
    """Load only the run columns stats needs, grouped by task id.

    This is the OOM fix: it projects a handful of scalar columns (including the
    Verdict counters) and never touches ``checks_json`` /
    ``transcript_json`` / ``deliverables_json``. Runs are returned in descending
    ``started_at`` order so the first element of each group is the most recent
    run (which ``compute_run_stats`` treats as ``latest``). Scoped to
    ``project_id`` via the parent batch run so two projects' runs never mix even
    if they share a task id.

    ``model`` / ``effort`` optionally scope the cohort to a single view (the
    Tasks page evidence views). Both default to ``None`` = all-history, which is
    the original behavior and what the Main tab shows.
    """
    if not task_ids:
        return {}

    conditions: list[ColumnElement[bool]] = [
        _TASK_ID_COL.in_(task_ids),
        _BATCH_PROJECT_COL == project_id,
    ]
    if model is not None:
        conditions.append(_CONFIGURED_MODEL_COL == model)
    if effort is not None:
        conditions.append(_CONFIGURED_EFFORT_COL == effort)

    stmt = (
        sa_select(
            _TASK_ID_COL,
            _STATUS_COL,
            _STARTED_AT_COL,
            _COMPLETED_AT_COL,
            _TOTAL_COST_COL,
            _PASS_RESULT_COL,
            _TOTAL_CHECKS_COL,
            _PASSED_CHECKS_COL,
        )
        .join(AgentTaskBatchRunDB, _BATCH_RUN_ID_COL == _BATCH_ID_COL)
        .where(*conditions)
        .order_by(desc(_STARTED_AT_COL))
    )
    rows = session.execute(stmt).all()

    grouped: dict[str, list[RunStatFields]] = {}
    for (
        task_id,
        status,
        started_at,
        completed_at,
        total_cost,
        pass_result,
        total_checks,
        passed_checks,
    ) in rows:
        grouped.setdefault(task_id, []).append(
            RunStatFields(
                status=status,
                started_at=started_at,
                completed_at=completed_at,
                total_cost=total_cost,
                pass_result=pass_result,
                total_checks=total_checks,
                passed_checks=passed_checks,
            )
        )
    return grouped


# Typed column handles mirroring ``routes/analytics.py``. The specific
# ``ColumnElement[T]`` parametrization (not ``[object]``) is what lets the
# core ``sa_select`` overloads resolve — and keeps these columns out of the
# SQLModel ``select`` overload that only accepts full models.
_TASK_ID_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.task_id))
_STATUS_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.status))
_STARTED_AT_COL: ColumnElement[datetime | None] = _as_column(
    cast(object, AgentTaskRunDB.started_at)
)
_COMPLETED_AT_COL: ColumnElement[datetime | None] = _as_column(
    cast(object, AgentTaskRunDB.completed_at)
)
_TOTAL_COST_COL: ColumnElement[float | None] = _as_column(
    cast(object, AgentTaskRunDB.total_cost)
)
_PASS_RESULT_COL: ColumnElement[bool | None] = _as_column(
    cast(object, AgentTaskRunDB.pass_result)
)
_TOTAL_CHECKS_COL: ColumnElement[int] = _as_column(cast(object, AgentTaskRunDB.total_checks))
_PASSED_CHECKS_COL: ColumnElement[int] = _as_column(
    cast(object, AgentTaskRunDB.passed_checks)
)
_BATCH_RUN_ID_COL: ColumnElement[str] = _as_column(
    cast(object, AgentTaskRunDB.batch_run_id)
)
_BATCH_ID_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskBatchRunDB.id))
_BATCH_PROJECT_COL: ColumnElement[str] = _as_column(
    cast(object, AgentTaskBatchRunDB.project)
)
_CONFIGURED_MODEL_COL: ColumnElement[str | None] = _as_column(
    cast(object, AgentTaskRunDB.configured_model)
)
_CONFIGURED_EFFORT_COL: ColumnElement[str | None] = _as_column(
    cast(object, AgentTaskRunDB.configured_effort)
)


def compute_run_config_facets(
    session: Session,
    project_id: str,
) -> list[RunConfigModelFacet]:
    """Distinct (model, effort) run configurations in a project, for the
    Tasks page filter dropdowns.

    Returns one entry per ``configured_model`` with the per-effort breakdown,
    sorted by descending run count. ``configured_model IS NULL`` rows (legacy
    runs reported before the v15 config columns existed) are excluded — they
    carry no usable filter value and would only clutter the palette.

    Projects only the two scalar config columns (no JSON blobs), then counts in
    Python — the distinct (model, effort) set is small, so this stays OOM-safe
    and fully typed (``func.count()`` would otherwise surface as ``Any``).
    """
    stmt = (
        sa_select(_CONFIGURED_MODEL_COL, _CONFIGURED_EFFORT_COL)
        .join(AgentTaskBatchRunDB, _BATCH_RUN_ID_COL == _BATCH_ID_COL)
        .where(
            _BATCH_PROJECT_COL == project_id,
            _CONFIGURED_MODEL_COL.is_not(None),
        )
    )
    rows = session.execute(stmt).all()

    # assemble (model -> {effort -> count}) then flatten into sorted facets.
    # null efforts count toward the model total but are excluded from the
    # effort facet list (they carry no usable filter value).
    by_model: dict[str, dict[str, int]] = {}
    model_totals: dict[str, int] = {}
    for model, effort in rows:
        if effort is not None:
            efforts = by_model.setdefault(model, {})
            efforts[effort] = efforts.get(effort, 0) + 1
        model_totals[model] = model_totals.get(model, 0) + 1

    facets: list[RunConfigModelFacet] = []
    # iterate model_totals (every model), not by_model — a model whose runs all
    # carry a null effort would be absent from by_model but still belongs in the
    # palette (with an empty effort list).
    for model in sorted(model_totals, key=lambda m: model_totals[m], reverse=True):
        efforts = by_model.get(model, {})
        effort_facets = [
            RunConfigEffortFacet(effort=effort, count=count)
            for effort, count in sorted(
                efforts.items(),
                key=lambda ec: ec[1],
                reverse=True,
            )
        ]
        facets.append(
            RunConfigModelFacet(
                model=model,
                count=model_totals[model],
                efforts=effort_facets,
            )
        )
    return facets
