"""SPEC-174 Phase 2 — selection-scoped view-vs-view comparison.

A comparison snapshot freezes, for a chosen set of tasks and two model/effort
views, the resolved run on each side plus the def/exec revisions actually used.
Snapshots are immutable and shareable by a short opaque id.

Resolution rule (matches the throwaway prototype's ``resolveCell`` and the
spec): latest *completed* run per task under the view (most recent non-errored
by ``started_at``); if only errored attempts exist, the latest errored attempt;
if no runs match, the side is unresolved (Not Run). Two sides are *comparable*
only when both resolved AND their task-definition revisions agree AND their
execution (batch) revisions agree — legacy batches with no ``TaskRevisionDB``
row compare as ``None == None`` (don't penalise pre-revision history).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import cast

from sqlalchemy import desc, select as sa_select
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session

from ..db_helpers import _as_column
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    TaskRevisionDB,
    TaskViewComparisonDB,
)
from ..models.schemas import (
    ResolvedComparisonCell,
    TaskViewComparisonSnapshot,
    TaskViewConfig,
)

# Status that means "the run did not complete" (no usable verdict). Mirrors
# ``compute_run_stats``, which counts "error" separately from "failed".
_ERRORED = "error"

# Typed column handles (mirrors ``agent_task_stats``): the explicit
# ``ColumnElement[T]`` lets the core ``sa_select`` overloads resolve and keeps
# these columns out of the SQLModel ``select`` overload that only accepts full
# models.
_RUN_ID_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.id))
_RUN_TASK_ID_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.task_id))
_RUN_STATUS_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.status))
_RUN_STARTED_COL: ColumnElement[object] = _as_column(cast(object, AgentTaskRunDB.started_at))
_RUN_BATCH_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskRunDB.batch_run_id))
_RUN_DEF_REV_COL: ColumnElement[str | None] = _as_column(
    cast(object, AgentTaskRunDB.task_definition_revision_id)
)
_RUN_MODEL_COL: ColumnElement[str | None] = _as_column(cast(object, AgentTaskRunDB.configured_model))
_RUN_EFFORT_COL: ColumnElement[str | None] = _as_column(cast(object, AgentTaskRunDB.configured_effort))
_BATCH_ID_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskBatchRunDB.id))
_BATCH_PROJECT_COL: ColumnElement[str] = _as_column(cast(object, AgentTaskBatchRunDB.project))
_REV_BATCH_COL: ColumnElement[str] = _as_column(cast(object, TaskRevisionDB.batch_run_id))
_REV_SHA_COL: ColumnElement[str] = _as_column(cast(object, TaskRevisionDB.content_sha256))


@dataclass(frozen=True, slots=True)
class _RunRow:
    """Minimal projection of a run that comparison resolution reads."""

    run_id: str
    status: str
    started_at: object
    batch_run_id: str
    task_definition_revision_id: str | None


@dataclass(frozen=True, slots=True)
class _ResolvedRun:
    run_id: str
    status: str | None
    task_definition_revision_id: str | None
    exec_revision_sha: str | None


def _short_id() -> str:
    """Short opaque id for a snapshot URL (``tvc_`` + 12 hex chars)."""
    return f"tvc_{secrets.token_hex(6)}"


def _resolve_side(
    session: Session,
    project_id: str,
    task_ids: list[str],
    view: TaskViewConfig,
) -> dict[str, _ResolvedRun]:
    """Resolve the latest-completed run per task under one view.

    Returns ``{task_id: _ResolvedRun}``; tasks with no matching run are absent.
    Bounded by the selection size, so this scalar projection is cheap.
    """
    if not task_ids:
        return {}

    conditions: list[ColumnElement[bool]] = [
        _RUN_TASK_ID_COL.in_(task_ids),
        _BATCH_PROJECT_COL == project_id,
    ]
    if view.model is not None:
        conditions.append(_RUN_MODEL_COL == view.model)
    if view.effort is not None:
        conditions.append(_RUN_EFFORT_COL == view.effort)

    stmt = (
        sa_select(
            _RUN_TASK_ID_COL,
            _RUN_ID_COL,
            _RUN_STATUS_COL,
            _RUN_STARTED_COL,
            _RUN_BATCH_COL,
            _RUN_DEF_REV_COL,
        )
        .join(AgentTaskBatchRunDB, _RUN_BATCH_COL == _BATCH_ID_COL)
        .where(*conditions)
        .order_by(_RUN_TASK_ID_COL, desc(_RUN_STARTED_COL))
    )
    # group matching runs by task, preserving started_at DESC order so the first
    # completed run seen per task is the latest completed.
    runs_by_task: dict[str, list[_RunRow]] = {}
    for task_id, run_id, status, started_at, batch_run_id, def_rev in session.execute(stmt).all():
        runs_by_task.setdefault(task_id, []).append(
            _RunRow(run_id, status, started_at, batch_run_id, def_rev)
        )

    # one lookup of the exec (batch) revision shas for every batch referenced by
    # a chosen run, so we don't N+1 per task.
    chosen: list[_RunRow] = []
    latest_by_task: dict[str, _RunRow] = {}
    for task_id, runs in runs_by_task.items():
        completed = [r for r in runs if r.status != _ERRORED]
        pick = (completed or runs)[0]
        latest_by_task[task_id] = pick
        chosen.append(pick)

    exec_shas: dict[str, str] = {}
    if chosen:
        batch_ids = {r.batch_run_id for r in chosen}
        rev_rows = session.execute(
            sa_select(_REV_BATCH_COL, _REV_SHA_COL).where(_REV_BATCH_COL.in_(batch_ids))
        ).all()
        exec_shas = {batch_id: sha for batch_id, sha in rev_rows}

    return {
        task_id: _ResolvedRun(
            run_id=run.run_id,
            status=run.status,
            task_definition_revision_id=run.task_definition_revision_id,
            exec_revision_sha=exec_shas.get(run.batch_run_id),
        )
        for task_id, run in latest_by_task.items()
    }


def _is_comparable(a: _ResolvedRun | None, b: _ResolvedRun | None) -> bool:
    """Both sides resolved AND def + exec revisions agree.

    ``None == None`` is allowed for legacy runs/batches that predate the revision
    tables, so old history isn't penalised — only an actual disagreement excludes.
    """
    if a is None or b is None:
        return False
    if a.task_definition_revision_id != b.task_definition_revision_id:
        return False
    if a.exec_revision_sha != b.exec_revision_sha:
        return False
    return True


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

    side_a = _resolve_side(session, project_id, task_ids, view_a)
    side_b = _resolve_side(session, project_id, task_ids, view_b)

    resolved: list[ResolvedComparisonCell] = []
    both_run = 0
    comparable_count = 0
    for task_id in task_ids:
        a = side_a.get(task_id)
        b = side_b.get(task_id)
        comparable = _is_comparable(a, b)
        if a is not None and b is not None:
            both_run += 1
        if comparable:
            comparable_count += 1
        resolved.append(
            ResolvedComparisonCell(
                task_id=task_id,
                a_run_id=a.run_id if a else None,
                b_run_id=b.run_id if b else None,
                a_status=a.status if a else None,
                b_status=b.status if b else None,
                comparable=comparable,
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
            "comparable": comparable_count,
            "scope": len(task_ids),
        },
        created_by=created_by,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _to_snapshot(row)


def get_comparison(
    session: Session, project_id: str, comparison_id: str
) -> TaskViewComparisonDB | None:
    """Load a snapshot row, scoped to the project (cross-project lookup is a 404)."""
    return session.get(TaskViewComparisonDB, comparison_id) if comparison_id.startswith("tvc_") else None


def _to_snapshot(row: TaskViewComparisonDB) -> TaskViewComparisonSnapshot:
    """Deserialize the stored JSON columns into the API view-model.

    JSON columns come back as ``object``-typed values, so the nested models are
    rebuilt via Pydantic ``model_validate`` (which validates + coerces) rather
    than ``**`` unpacking.
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


def to_snapshot(row: TaskViewComparisonDB) -> TaskViewComparisonSnapshot:
    """Public deserialize wrapper for route handlers."""
    return _to_snapshot(row)
