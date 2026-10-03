"""Aggregation of agent-task runs into stats summaries.

Single source of truth for the per-task / per-project roll-up used by both
the project-scoped and discovery-scoped routes. Previously this computation
was duplicated (and kept in sync by a docstring promise) across
``routes/projects.py`` and ``routes/agent_task_runs.py``; both now delegate
here so the numbers cannot drift.

Performance contract: ``load_run_stat_fields`` delegates cohort selection to
``runs_in_view`` (the shared seam with ``task_view_comparison``) and projects
each cohort row into ``RunStatFields``. The cohort query never fetches
``transcript_json`` / ``deliverables_json`` — those JSON blobs can be MBs per
row and loading them for every historical run caused the backend to be
OOM-killed on the task list page in production. ``RunStatFields`` is the
explicit minimal shape, so the cost cannot silently regress: there is no
attribute on it that *could* hold a transcript.
"""

# pyright: reportAny=false, reportDeprecated=false, reportPrivateUsage=false

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select as sa_select
from sqlmodel import Session

from ..models.columns import (
    AGENT_TASK_BATCH_ID_COL,
    AGENT_TASK_BATCH_PROJECT_COL,
    AGENT_TASK_RUN_BATCH_RUN_ID_COL,
    AGENT_TASK_RUN_CONFIGURED_EFFORT_COL,
    AGENT_TASK_RUN_CONFIGURED_MODEL_COL,
)
from ..models.db import AgentTaskBatchRunDB
from ..models.schemas import (
    AgentTaskRunStats,
    RunConfigEffortFacet,
    RunConfigModelFacet,
    TaskViewConfig,
    as_no_verdict_reason,
)

from ..models.schemas import AgentTaskRunStats, RunConfigEffortFacet, RunConfigModelFacet, TaskViewConfig, RunHostFacet
from .archived_models import load_archived_models
from .check_report_storage import is_judge_no_verdict_run
from .view_runs import runs_in_view


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
    errored_checks: int = 0
    # An ``error`` run with no verdict only because the judge gave none
    # (issue #323) — told apart from an execution error on the Tasks page.
    judge_no_verdict: bool = False
    no_verdict_reason: str | None = None


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
    errored_checks = sum(r.errored_checks for r in runs)

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
        last_run_no_verdict=latest.judge_no_verdict if latest else False,
        last_run_no_verdict_reason=as_no_verdict_reason(latest.no_verdict_reason if latest else None),
        total_checks=total_checks,
        checks_pass_rate=round(passed_checks / total_checks, 2)
        if total_checks > 0
        else 0.0,
        errored_checks=errored_checks,
        avg_cost=round(sum(costs) / len(costs), 4) if costs else None,
    )


def load_run_stat_fields(
    session: Session,
    project_id: str,
    task_ids: list[str],
    model: str | None = None,
    effort: str | None = None,
    since: str | None = None,
    provider: str | None = None,
) -> dict[str, list[RunStatFields]]:
    """Load the run columns stats needs, grouped by task id.

    Delegates cohort selection to ``runs_in_view`` — the shared seam between
    this aggregator and ``task_view_comparison`` — and projects each wide
    cohort row into the narrower ``RunStatFields`` shape that
    ``compute_run_stats`` reads. The OOM-safety contract is preserved:
    ``runs_in_view`` projects only scalar columns, never ``checks_json`` /
    ``transcript_json`` / ``deliverables_json``.

    Runs are returned in descending ``started_at`` order (the cohort's
    contract) so the first element of each task group is the most recent run,
    which ``compute_run_stats`` treats as ``latest``.
    """
    cohort = runs_in_view(
        session,
        project_id=project_id,
        task_ids=task_ids,
        view=TaskViewConfig(model=model, effort=effort, since=since, provider=provider),
    )
    grouped: dict[str, list[RunStatFields]] = {}
    for run in cohort:
        grouped.setdefault(run.task_id, []).append(
            RunStatFields(
                status=run.status,
                started_at=run.started_at,
                completed_at=run.completed_at,
                total_cost=run.total_cost,
                pass_result=run.pass_result,
                total_checks=run.total_checks,
                passed_checks=run.passed_checks,
                errored_checks=run.errored_checks,
                judge_no_verdict=is_judge_no_verdict_run(run),
                no_verdict_reason=run.no_verdict_reason,
            )
        )
    return grouped


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

    Models the project has archived are returned with ``archived=True`` rather
    than dropped: the client hides them but can reveal them to un-archive, and
    it must keep rendering one that the active filter still selects.

    Projects only the two scalar config columns (no JSON blobs), then counts in
    Python — the distinct (model, effort) set is small, so this stays OOM-safe
    and fully typed (``func.count()`` would otherwise surface as ``Any``).
    """
    stmt = (
        sa_select(AGENT_TASK_RUN_CONFIGURED_MODEL_COL, AGENT_TASK_RUN_CONFIGURED_EFFORT_COL)
        .join(AgentTaskBatchRunDB, AGENT_TASK_RUN_BATCH_RUN_ID_COL == AGENT_TASK_BATCH_ID_COL)
        .where(
            AGENT_TASK_BATCH_PROJECT_COL == project_id,
            AGENT_TASK_RUN_CONFIGURED_MODEL_COL.is_not(None),
        )
    )
    rows = session.execute(stmt).all()
    archived = load_archived_models(session, project_id)

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
                archived=model in archived,
            )
        )
    return facets

def compute_run_host_facets(
    session: Session, project_id: str, model: str | None = None
) -> list[RunHostFacet]:
    """Distinct serving-host labels over a project's task runs (issue #307).

    Route-wins per call (the projection the run rows display), counted in
    distinct task runs. ``model`` scopes the facet to one model's runs — the
    Hosts filter appears after a model is picked (like the effort tiers), so
    its counts must reflect that cohort, not the whole project. Scalar
    columns only — OOM-safe like the model facets.
    """
    from sqlalchemy import and_, func as sa_func
    from sqlalchemy import select as sa_sel

    from ..db_helpers import as_column
    from ..models.columns import AGENT_TASK_RUN_CONFIGURED_MODEL_COL
    from ..models.db import AgentTaskRunDB, LoggedCallDB

    label = sa_func.coalesce(
        sa_func.nullif(as_column(LoggedCallDB.route), ""),
        sa_func.nullif(as_column(LoggedCallDB.provider), ""),
    )
    conditions = [
        as_column(AgentTaskBatchRunDB.project) == project_id,
        as_column(AgentTaskRunDB.trace_run_id).is_not(None),
        label.is_not(None),
    ]
    if model is not None:
        conditions.append(AGENT_TASK_RUN_CONFIGURED_MODEL_COL == model)
    stmt = (
        sa_sel(label, sa_func.count(sa_func.distinct(as_column(AgentTaskRunDB.id))))
        .select_from(AgentTaskRunDB)
        .join(
            AgentTaskBatchRunDB,
            as_column(AgentTaskBatchRunDB.id) == as_column(AgentTaskRunDB.batch_run_id),
        )
        .join(
            LoggedCallDB,
            and_(
                as_column(LoggedCallDB.run_id) == as_column(AgentTaskRunDB.trace_run_id),
                as_column(LoggedCallDB.project) == as_column(AgentTaskBatchRunDB.project),
            ),
        )
        .where(*conditions)
        .group_by(label)
    )
    rows = session.execute(stmt).all()
    return [
        RunHostFacet(label=str(value), count=int(count))
        for value, count in sorted(rows, key=lambda r: (-int(r[1]), str(r[0])))
    ]
