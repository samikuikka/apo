"""The view-scoped run cohort — the shared seam between stats and comparison.

Both ``agent_task_stats.load_run_stat_fields`` (aggregates every matching run
into project stats) and ``task_view_comparison._resolve_side`` (picks the
latest-completed run per task) answer the same domain question:

    *Which runs in this project match this view (model / effort / since),
     scoped to this selection of tasks?*

That question — the cohort — is what this module owns. The JOIN on
``AgentTaskBatchRunDB``, the project / task_ids / model / effort / since
filter conditions, the typed column handles, and the descending ``started_at``
ordering all live here. Consumers project the cohort rows into whatever shape
they need (stats sums; comparison picks) and never re-derive the filter.

Returning a single wide ``ViewRun`` is deliberate: every field any consumer
has needed so far is a scalar, so projecting the union costs microseconds on
the bounded selections comparison and stats actually serve. A JSON or
transcript column would change that calculus — none is included.
"""

# pyright: reportAny=false, reportDeprecated=false, reportPrivateUsage=false

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import desc, or_, select as sa_select
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session

from ..models.columns import (
    AGENT_TASK_BATCH_ID_COL,
    AGENT_TASK_BATCH_PROJECT_COL,
    AGENT_TASK_RUN_BATCH_RUN_ID_COL,
    AGENT_TASK_RUN_COMPLETED_AT_COL,
    AGENT_TASK_RUN_CONFIGURED_EFFORT_COL,
    AGENT_TASK_RUN_CONFIGURED_MODEL_COL,
    AGENT_TASK_RUN_CORRECTED_TESTS_COL,
    AGENT_TASK_RUN_DEFINITION_REVISION_COL,
    AGENT_TASK_RUN_ERRORED_CHECKS_COL,
    AGENT_TASK_RUN_ID_COL,
    AGENT_TASK_RUN_PASSED_CHECKS_COL,
    AGENT_TASK_RUN_PASS_RESULT_COL,
    AGENT_TASK_RUN_STARTED_AT_COL,
    AGENT_TASK_RUN_STATUS_COL,
    AGENT_TASK_RUN_TASK_ID_COL,
    AGENT_TASK_RUN_TOTAL_CHECKS_COL,
    AGENT_TASK_RUN_TOTAL_COST_COL,
)
from ..models.db import AgentTaskBatchRunDB
from ..models.schemas import TaskViewConfig


@dataclass(frozen=True, slots=True)
class ViewRun:
    """One run in the cohort, carrying every scalar field any consumer reads.

    Fields are the union of what stats (cost / verdict counters) and
    comparison (run identity + def revision) currently need. Adding a
    consumer that needs another scalar column means adding it here —
    not re-deriving the query.
    """

    run_id: str
    task_id: str
    status: str
    started_at: datetime | None
    completed_at: datetime | None
    total_cost: float | None
    pass_result: bool | None
    total_checks: int
    passed_checks: int
    # Judge-errored checks (hot run scalar, issue #323).
    errored_checks: int
    # Effective-projection correction count (hot run scalar).
    corrected_tests: int
    task_definition_revision_id: str | None


def since_cutoff(since: str | None) -> datetime | None:
    """Resolve a ``since`` preset to a UTC cutoff.

    Accepts ``Nh`` (hours) or ``Nd`` (days), e.g. ``"5h"``, ``"3d"``. Returns
    ``None`` for all-time (no preset, unparseable, or out of range). Owned here
    so the cohort is the single authority on what a date window means.
    """
    if not since:
        return None
    try:
        if since.endswith("h"):
            return datetime.now(timezone.utc) - timedelta(hours=int(since[:-1]))
        if since.endswith("d"):
            return datetime.now(timezone.utc) - timedelta(days=int(since[:-1]))
    except (OverflowError, ValueError):
        pass
    return None


def runs_in_view(
    session: Session,
    project_id: str,
    task_ids: list[str],
    view: TaskViewConfig,
    exclude_model: str | None = None,
) -> list[ViewRun]:
    """Return every run in ``project_id`` matching ``view``, scoped to ``task_ids``.

    The cohort is the set of runs both stats and comparison operate on. It
    is ordered by ``started_at DESC`` so consumers can rely on the first row per
    task being the most recent. Empty ``task_ids`` returns an empty list
    (matches the original guard in both consumers).

    The view filter is interpreted as: ``model`` exact match (None = any),
    ``effort`` exact match (None = any), ``since`` is a ``"Nh"``/``"Nd"``
    window over ``started_at`` (None = all time). Project scoping goes through
    the parent ``AgentTaskBatchRunDB`` so two projects' runs never mix even
    when they share a task id.

    ``exclude_model`` removes one model from an otherwise unpinned ("any
    model") cohort — the superset-vs-member comparison rule (issue #140):
    comparing "all models" against one specific model must resolve the
    unpinned side to *everything else*, or the member's latest run gets
    paired against itself. NULL-model legacy rows are kept: SQL ``!=``
    drops NULLs, so the condition is explicitly NULL-safe. It is ignored
    when ``view.model`` is set (a pinned cohort has no superset problem).
    """
    if not task_ids:
        return []

    conditions: list[ColumnElement[bool]] = [
        AGENT_TASK_RUN_TASK_ID_COL.in_(task_ids),
        AGENT_TASK_BATCH_PROJECT_COL == project_id,
    ]
    if view.model is not None:
        conditions.append(AGENT_TASK_RUN_CONFIGURED_MODEL_COL == view.model)
    elif exclude_model is not None:
        conditions.append(
            or_(
                AGENT_TASK_RUN_CONFIGURED_MODEL_COL != exclude_model,
                AGENT_TASK_RUN_CONFIGURED_MODEL_COL.is_(None),
            )
        )
    if view.effort is not None:
        conditions.append(AGENT_TASK_RUN_CONFIGURED_EFFORT_COL == view.effort)
    cutoff = since_cutoff(view.since)
    if cutoff is not None:
        conditions.append(AGENT_TASK_RUN_STARTED_AT_COL >= cutoff)

    stmt = (
        sa_select(
            AGENT_TASK_RUN_ID_COL,
            AGENT_TASK_RUN_TASK_ID_COL,
            AGENT_TASK_RUN_STATUS_COL,
            AGENT_TASK_RUN_STARTED_AT_COL,
            AGENT_TASK_RUN_COMPLETED_AT_COL,
            AGENT_TASK_RUN_TOTAL_COST_COL,
            AGENT_TASK_RUN_PASS_RESULT_COL,
            AGENT_TASK_RUN_TOTAL_CHECKS_COL,
            AGENT_TASK_RUN_PASSED_CHECKS_COL,
            AGENT_TASK_RUN_ERRORED_CHECKS_COL,
            AGENT_TASK_RUN_CORRECTED_TESTS_COL,
            AGENT_TASK_RUN_DEFINITION_REVISION_COL,
        )
        .join(AgentTaskBatchRunDB, AGENT_TASK_RUN_BATCH_RUN_ID_COL == AGENT_TASK_BATCH_ID_COL)
        .where(*conditions)
        .order_by(desc(AGENT_TASK_RUN_STARTED_AT_COL))
    )

    runs: list[ViewRun] = []
    for (
        run_id,
        task_id,
        status,
        started_at,
        completed_at,
        total_cost,
        pass_result,
        total_checks,
        passed_checks,
        errored_checks,
        corrected_tests,
        def_rev,
    ) in session.execute(stmt).all():
        runs.append(
            ViewRun(
                run_id=run_id,
                task_id=task_id,
                status=status,
                started_at=started_at,
                completed_at=completed_at,
                total_cost=total_cost,
                pass_result=pass_result,
                total_checks=total_checks,
                passed_checks=passed_checks,
                errored_checks=errored_checks,
                corrected_tests=corrected_tests,
                task_definition_revision_id=def_rev,
            )
        )
    return runs
