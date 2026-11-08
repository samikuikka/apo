"""— selection-scoped view-vs-view comparison.

A comparison snapshot freezes, for a chosen set of tasks and two model/effort
views, the resolved run on each side plus the task-definition revision each
side used. Snapshots are immutable and shareable by a short opaque id.

Resolution rule (matches the throwaway prototype's ``resolveCell`` and the
spec): latest *completed* run per task under the view (most recent non-errored
by ``started_at``); if only errored attempts exist, the latest errored attempt;
if no runs match, the side is unresolved (Not Run). A task's comparison state
is ``aligned`` only when both sides resolved and their task-definition
revisions agree; the bundle-level execution revision is intentionally not a
gate (see ``_comparison_state``).
"""

from __future__ import annotations

import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, cast

from sqlmodel import Session, col, select

from ..models.db import (
    AgentTaskRunDB,
    TaskViewComparisonDB,
)
from ..models.schemas import (
    ResolvedComparisonCell,
    TaskViewComparisonSnapshot,
    TaskViewConfig,
    as_no_verdict_reason,
)
from ..models.serving import ServingSummary
from .lifecycle import is_never_started_run
from .serving import load_call_rows, summarize_calls
from .view_runs import ViewRun, runs_in_view

# Status that means "the run did not complete" (no usable verdict). Mirrors
# ``compute_run_stats``, which counts "error" separately from "failed".
_ERRORED = "error"
_ACTIVE = ("pending", "running")


@dataclass(frozen=True, slots=True)
class _ResolvedRun:
    run_id: str
    status: str | None
    task_definition_revision_id: str | None
    # Effective verdict/count scalars frozen at snapshot creation.
    pass_result: bool | None
    total_checks: int | None
    passed_checks: int | None
    errored_checks: int
    corrected_tests: int
    no_verdict_reason: str | None


def _short_id() -> str:
    """Short opaque id for a snapshot URL (``tvc_`` + 12 hex chars)."""
    return f"tvc_{secrets.token_hex(6)}"


def _resolve_side(
    session: Session,
    project_id: str,
    task_ids: list[str],
    view: TaskViewConfig,
    exclude_model: str | None = None,
) -> dict[str, _ResolvedRun]:
    """Resolve the latest-completed run per task under one view.

    Returns ``{task_id: _ResolvedRun}``; tasks with no matching run are absent.
    Delegates cohort selection to ``runs_in_view`` (the shared seam with
    ``agent_task_stats``) and applies the per-task "latest completed, else
    latest errored" resolution rule on top. ``exclude_model`` is the
    superset-vs-member rule from :func:`create_comparison`.
    """
    cohort = runs_in_view(
        session,
        project_id=project_id,
        task_ids=task_ids,
        view=view,
        exclude_model=exclude_model,
    )

    # cohort is already DESC by started_at, so the first run seen per task is
    # the most recent. Group preserving that order, then pick latest-completed.
    # A run that never started has no outcome; leaving it out keeps a task
    # whose only runs expired in the queue "not run", as its card reads.
    runs_by_task: dict[str, list[ViewRun]] = {}
    for run in cohort:
        if is_never_started_run(run.status, run.started_at, run.no_verdict_reason):
            continue
        runs_by_task.setdefault(run.task_id, []).append(run)

    latest_by_task: dict[str, ViewRun] = {}
    for task_id, runs in runs_by_task.items():
        # Outcomes first. A live queued/running run is frozen only when the
        # side has nothing else (the overview reads its verdict once it
        # lands); it counts as not run. A stuck one never finishes: skipped.
        done = [r for r in runs if r.status not in (_ERRORED, *_ACTIVE)]
        errored = [r for r in runs if r.status == _ERRORED]
        live = [r for r in runs if r.live]
        pick = done or errored or live
        if pick:
            latest_by_task[task_id] = pick[0]

    return {
        task_id: _ResolvedRun(
            run_id=run.run_id,
            status=run.status,
            task_definition_revision_id=run.task_definition_revision_id,
            pass_result=run.pass_result,
            total_checks=run.total_checks,
            passed_checks=run.passed_checks,
            errored_checks=run.errored_checks,
            corrected_tests=run.corrected_tests,
            no_verdict_reason=run.no_verdict_reason,
        )
        for task_id, run in latest_by_task.items()
    }


def _run_serving_summaries(
    session: Session,
    project_id: str,
    run_ids: Sequence[str],
) -> Mapping[str, ServingSummary]:
    """Bounded serving summaries for the resolved runs, keyed by run id.

    One query for the runs' trace links plus one batched call-row query —
    the comparison size never multiplies database reads. A resolved run
    without a linked trace freezes as ``no_data``, which is the honest
    statement about its (absent) evidence.
    """
    unique_ids = list(dict.fromkeys(run_ids))
    if not unique_ids:
        return {}
    rows = session.exec(
        select(AgentTaskRunDB.id, AgentTaskRunDB.trace_run_id).where(
            col(AgentTaskRunDB.id).in_(unique_ids)
        )
    ).all()
    trace_by_run = {run_id: trace_id for run_id, trace_id in rows}
    trace_ids = [trace_id for trace_id in trace_by_run.values() if trace_id]
    calls_by_trace = load_call_rows(session, project=project_id, run_ids=trace_ids)
    return {
        run_id: summarize_calls(
            calls_by_trace.get(trace_id, []) if trace_id else []
        )
        for run_id, trace_id in trace_by_run.items()
    }


def _comparison_state(
    a: _ResolvedRun | None, b: _ResolvedRun | None
) -> Literal["aligned", "different_definition", "not_run"]:
    """Three-valued comparison state for a task across two sides.

    Replaces the former boolean ``_is_comparable``. Collapsing ``not_run`` and
    ``different_definition`` into a single ``False`` made tasks that simply
    didn't run on one side render as "different eval version". Keeping the
    states distinct lets each consumer show the right message.

    Only ``task_definition_revision_id`` gates the definition check — the eval
    file that defines the checks must be the same on both sides. The
    bundle-level exec (batch) revision (which spans the whole task root, not
    just this task's eval) is intentionally NOT a gate: any edit anywhere in
    the task tree would flip it, making two runs from different days almost
    never ``aligned`` even when the specific task's definition is byte-identical.
    """
    if a is None or b is None or a.status in _ACTIVE or b.status in _ACTIVE:
        return "not_run"
    if a.task_definition_revision_id != b.task_definition_revision_id:
        return "different_definition"
    return "aligned"


def create_comparison(
    session: Session,
    project_id: str,
    task_ids: list[str],
    view_a: TaskViewConfig,
    view_b: TaskViewConfig,
    created_by: str | None = None,
) -> TaskViewComparisonSnapshot:
    """Resolve both sides, compute coverage, persist an immutable snapshot."""
    if not task_ids:
        raise ValueError("comparison selection must not be empty")

    # Superset-vs-member rule (issue #140): "all models" (model=None) is not
    # a cohort — it is the union that *contains* any specific model's view.
    # Resolved naively, the unpinned side picks the globally-latest run per
    # task, which for the pinned model's dominant runs is the *same run* the
    # pinned side picks: every row pairs a run against itself and the
    # comparison reports "all tasks are identical". When exactly one side
    # pins a model, the unpinned side excludes it — comparing that model
    # against "everything else", which is the only meaningful reading.
    exclude_from_a = view_b.model if (view_a.model is None and view_b.model is not None) else None
    exclude_from_b = view_a.model if (view_b.model is None and view_a.model is not None) else None

    side_a = _resolve_side(session, project_id, task_ids, view_a, exclude_model=exclude_from_a)
    side_b = _resolve_side(session, project_id, task_ids, view_b, exclude_model=exclude_from_b)

    # Frozen observed-serving evidence (issue #307): each resolved side's
    # bounded summary (with its cost coverage) captured now, so late spans
    # or repricing never rewrite what the snapshot shows. The per-side
    # serving filter rides along in the frozen view configs.
    run_serving = _run_serving_summaries(
        session,
        project_id,
        [run.run_id for side in (side_a, side_b) for run in side.values()],
    )

    resolved: list[ResolvedComparisonCell] = []
    both_run = 0
    aligned_count = 0
    for task_id in task_ids:
        a = side_a.get(task_id)
        b = side_b.get(task_id)
        state = _comparison_state(a, b)
        if state != "not_run":
            both_run += 1
        if state == "aligned":
            aligned_count += 1
        resolved.append(
            ResolvedComparisonCell(
                task_id=task_id,
                a_run_id=a.run_id if a else None,
                b_run_id=b.run_id if b else None,
                a_status=a.status if a else None,
                b_status=b.status if b else None,
                state=state,
                # Freeze the current effective scalars so the
                # snapshot renders identically even after later corrections.
                a_pass_result=a.pass_result if a else None,
                a_total_checks=a.total_checks if a else None,
                a_passed_checks=a.passed_checks if a else None,
                a_errored_checks=a.errored_checks if a else None,
                a_corrected_tests=a.corrected_tests if a else None,
                a_no_verdict_reason=as_no_verdict_reason(a.no_verdict_reason) if a else None,
                b_pass_result=b.pass_result if b else None,
                b_total_checks=b.total_checks if b else None,
                b_passed_checks=b.passed_checks if b else None,
                b_errored_checks=b.errored_checks if b else None,
                b_corrected_tests=b.corrected_tests if b else None,
                b_no_verdict_reason=as_no_verdict_reason(b.no_verdict_reason) if b else None,
                a_serving=run_serving.get(a.run_id) if a else None,
                b_serving=run_serving.get(b.run_id) if b else None,
            )
        )

    snapshot_id = _short_id()
    row = TaskViewComparisonDB(
        id=snapshot_id,
        project_id=project_id,
        view_a_config=view_a.model_dump(),
        view_b_config=view_b.model_dump(),
        task_ids=list(task_ids),
        resolved=[c.model_dump() for c in resolved],
        coverage={
            "both_run": both_run,
            "aligned": aligned_count,
            "scope": len(task_ids),
        },
        created_by=created_by,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return to_snapshot(row)


def get_comparison(
    session: Session, project_id: str, comparison_id: str
) -> TaskViewComparisonDB | None:
    """Load a snapshot row, scoped to the project (cross-project lookup is a 404).

    Filtering at the query level (not just the caller) prevents a future call
    site from trusting the docstring and skipping the manual project check.
    """
    if not comparison_id.startswith("tvc_"):
        return None
    row = session.get(TaskViewComparisonDB, comparison_id)
    if row is None or row.project_id != project_id:
        return None
    return row


def to_snapshot(row: TaskViewComparisonDB) -> TaskViewComparisonSnapshot:
    """Deserialize the stored JSON columns into the API view-model.

    JSON columns come back as ``object``-typed values, so the nested models are
    rebuilt via Pydantic ``model_validate`` (which validates + coerces) rather
    than ``from_orm`` or ``**`` unpacking.
    """
    return TaskViewComparisonSnapshot(
        id=row.id,
        project_id=row.project_id,
        view_a_config=TaskViewConfig.model_validate(row.view_a_config),
        view_b_config=TaskViewConfig.model_validate(row.view_b_config),
        task_ids=list(row.task_ids),
        resolved=[ResolvedComparisonCell.model_validate(cell) for cell in row.resolved],
        coverage={str(k): cast(int, v) for k, v in row.coverage.items()},
        created_at=row.created_at,
        created_by=row.created_by,
    )
