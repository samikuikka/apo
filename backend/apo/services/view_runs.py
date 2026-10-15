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

from sqlalchemy import and_, desc, exists, or_, select as sa_select
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session

from .executor_auth import (
    ATTEMPT_LEASE_SECONDS,
    DEFAULT_QUEUE_TTL_SECONDS,
    REAPER_INTERVAL_SECONDS,
)
from ..models.columns import (
    AGENT_TASK_BATCH_CREATED_AT_COL,
    AGENT_TASK_BATCH_ID_COL,
    AGENT_TASK_BATCH_PROJECT_COL,
    AGENT_TASK_RUN_BATCH_RUN_ID_COL,
    AGENT_TASK_RUN_COMPLETED_AT_COL,
    AGENT_TASK_RUN_CONFIGURED_EFFORT_COL,
    AGENT_TASK_RUN_CONFIGURED_MODEL_COL,
    AGENT_TASK_RUN_CORRECTED_TESTS_COL,
    AGENT_TASK_RUN_DEFINITION_REVISION_COL,
    AGENT_TASK_RUN_ERRORED_CHECKS_COL,
    AGENT_TASK_RUN_FAILED_CHECKS_COL,
    AGENT_TASK_RUN_NO_VERDICT_REASON_COL,
    AGENT_TASK_RUN_ID_COL,
    AGENT_TASK_RUN_PASSED_CHECKS_COL,
    AGENT_TASK_RUN_PASS_RESULT_COL,
    AGENT_TASK_RUN_STARTED_AT_COL,
    AGENT_TASK_RUN_STATUS_COL,
    AGENT_TASK_RUN_TASK_ID_COL,
    AGENT_TASK_RUN_TOTAL_CHECKS_COL,
    AGENT_TASK_RUN_TOTAL_COST_COL,
    AGENT_TASK_RUN_TRACE_RUN_ID_COL,
)
from ..db_helpers import as_column
from ..models.db import AgentTaskBatchRunDB, TaskExecutionAttemptDB
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
    # What the judge no-verdict gate reads (issue #323) — two small scalars.
    failed_checks: int = 0
    no_verdict_reason: str | None = None
    # Queued or running in a batch young enough to still be live; see live_run.
    live: bool = False


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


# Runs without an attempt row (the legacy external path) have no queue TTL or
# lease to read, so their batch's age stands in: past the default TTL plus a
# lease, a pending/running row there is a stuck leftover, not live work.
LIVE_BATCH_WINDOW = timedelta(seconds=DEFAULT_QUEUE_TTL_SECONDS + ATTEMPT_LEASE_SECONDS)

_ATTEMPT_RUN_ID = as_column(TaskExecutionAttemptDB.task_run_id)
_ATTEMPT_STATUS = as_column(TaskExecutionAttemptDB.status)
_ATTEMPT_QUEUE_EXPIRES = as_column(TaskExecutionAttemptDB.queue_expires_at)
_ATTEMPT_LEASE_EXPIRES = as_column(TaskExecutionAttemptDB.lease_expires_at)


def live_run() -> ColumnElement[bool]:
    """A run still queued or running that can still produce a result.

    Read from its attempt: queued before its queue TTL, or leased/running
    within its lease (plus one reaper sweep). The subqueries correlate on the
    run only, so this holds whether or not the outer query joins the batch.
    """
    now = datetime.now(timezone.utc)
    live_attempt = (
        exists()
        .where(
            _ATTEMPT_RUN_ID == AGENT_TASK_RUN_ID_COL,
            or_(
                and_(_ATTEMPT_STATUS == "queued", _ATTEMPT_QUEUE_EXPIRES > now),
                and_(
                    _ATTEMPT_STATUS.in_(("leased", "running")),
                    _ATTEMPT_LEASE_EXPIRES
                    > now - timedelta(seconds=REAPER_INTERVAL_SECONDS),
                ),
            ),
        )
        .correlate_except(TaskExecutionAttemptDB)
    )
    any_attempt = (
        exists()
        .where(_ATTEMPT_RUN_ID == AGENT_TASK_RUN_ID_COL)
        .correlate_except(TaskExecutionAttemptDB)
    )
    young_batch = (
        exists()
        .where(
            AGENT_TASK_BATCH_ID_COL == AGENT_TASK_RUN_BATCH_RUN_ID_COL,
            AGENT_TASK_BATCH_CREATED_AT_COL >= now - LIVE_BATCH_WINDOW,
        )
        .correlate_except(AgentTaskBatchRunDB)
    )
    return and_(
        AGENT_TASK_RUN_STATUS_COL.in_(("pending", "running")),
        or_(live_attempt, and_(~any_attempt, young_batch)),
    )


def not_started_run() -> ColumnElement[bool]:
    """SQL encoding of ``is_never_started_run`` (services/lifecycle.py).

    Kept beside ``live_run`` so the list endpoint's ``exclude_not_started``
    filter and the stats cohort classify the same rows: an ``error`` run
    without ``started_at`` whose no-verdict reason is not judge/generations
    (those mean checks ran). A NULL reason must count as never-started, which
    plain ``NOT IN`` would drop.
    """
    return and_(
        AGENT_TASK_RUN_STATUS_COL == "error",
        AGENT_TASK_RUN_STARTED_AT_COL.is_(None),
        or_(
            AGENT_TASK_RUN_NO_VERDICT_REASON_COL.is_(None),
            AGENT_TASK_RUN_NO_VERDICT_REASON_COL.notin_(("judge", "generations")),
        ),
    )


def in_since_window(cutoff: datetime) -> ColumnElement[bool]:
    """A run is inside a ``since`` window by when it started, or, if it never
    started, by when it ended; a live run waiting to start always is.

    Shared by the Tasks view cohort and the run list so a drill-down from a
    since-scoped view shows the runs the view's stats were computed from. The
    started_at arm is the indexed one; the NULL arms add the unstarted rows.
    """
    return or_(
        AGENT_TASK_RUN_STARTED_AT_COL >= cutoff,
        and_(
            AGENT_TASK_RUN_STARTED_AT_COL.is_(None),
            or_(
                AGENT_TASK_RUN_COMPLETED_AT_COL >= cutoff,
                and_(AGENT_TASK_RUN_COMPLETED_AT_COL.is_(None), live_run()),
            ),
        ),
    )


def runs_in_view(
    session: Session,
    project_id: str,
    task_ids: list[str],
    view: TaskViewConfig,
    exclude_model: str | None = None,
) -> list[ViewRun]:
    """Return every run in ``project_id`` matching ``view``, scoped to ``task_ids``.

    The cohort is the set of runs both stats and comparison operate on. It
    is ordered latest-first — a live queued or running run leads its task,
    then the most recently started — so consumers can rely on the first row
    per task being that task's latest run. Empty ``task_ids`` returns an
    empty list (matches the original guard in both consumers).

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
    # Serving host (issue #307): the run's trace was served by a matching
    # provider or route. Project-correlated — trace ids may collide across
    # projects, so another project's copy of a trace must not leak in.
    if view.provider is not None:
        from sqlalchemy import func as sa_func

        from ..db_helpers import as_column
        from ..models.db import LoggedCallDB

        value = view.provider.lower()
        call_run_col = as_column(LoggedCallDB.run_id)
        call_project_col = as_column(LoggedCallDB.project)
        matching_traces = sa_select(call_run_col).where(
            call_run_col == AGENT_TASK_RUN_TRACE_RUN_ID_COL,
            call_project_col == AGENT_TASK_BATCH_PROJECT_COL,
            or_(
                sa_func.lower(as_column(LoggedCallDB.provider)) == value,
                sa_func.lower(as_column(LoggedCallDB.route)) == value,
            ),
        )
        conditions.append(AGENT_TASK_RUN_TRACE_RUN_ID_COL.in_(matching_traces))
    cutoff = since_cutoff(view.since)
    if cutoff is not None:
        conditions.append(in_since_window(cutoff))

    live_label = live_run().label("live")
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
            AGENT_TASK_RUN_FAILED_CHECKS_COL,
            AGENT_TASK_RUN_NO_VERDICT_REASON_COL,
            live_label,
        )
        .join(AgentTaskBatchRunDB, AGENT_TASK_RUN_BATCH_RUN_ID_COL == AGENT_TASK_BATCH_ID_COL)
        .where(*conditions)
        # The first row per task is its latest run: a live queued or running
        # one first (the card reads "Running"), then the most recently started.
        # NULLs are placed explicitly because Postgres sorts them first under
        # DESC and SQLite last; ended-but-never-started rows go last.
        .order_by(
            desc(live_label),
            desc(AGENT_TASK_RUN_STARTED_AT_COL).nulls_last(),
            desc(AGENT_TASK_BATCH_CREATED_AT_COL),
        )
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
        failed_checks,
        no_verdict_reason,
        live,
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
                failed_checks=failed_checks,
                no_verdict_reason=no_verdict_reason,
                live=bool(live),
            )
        )
    return runs
