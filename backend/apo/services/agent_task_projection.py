"""Projection from agent-task DB rows to product-shape view models.

Pure functions that turn ``AgentTaskRunDB`` / ``AgentTaskBatchRunDB`` rows
into the ``AgentTaskRunSummary`` / ``AgentTaskBatchRunSummary`` /
``AgentTaskBatchRunDetail`` shapes the API returns. Extracted from the
route module so the projection logic has a real test surface and route
handlers shrink to "select -> project -> respond".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Literal, cast

from ..models import (
    AgentTaskBatchRunConfigurationSummary,
    AgentTaskBatchRunDB,
    AgentTaskBatchRunDetail,
    AgentTaskBatchRunSummary,
    AgentTaskRunConfiguration,
    AgentTaskRunDB,
    AgentTaskRunTrigger,
    AgentTaskRunSummary,
)
from ..models.db import TaskExecutionAttemptDB
from ..models.execution import (
    AttemptStatus,
    AttemptSummary,
    AttemptWaitingReason,
    ExecutionPhase,
    ExecutionTarget,
    PoolExecutionTarget,
    SourceOwnedExecutionTarget,
    TaskRevisionSummary,
)
from .agent_task_configuration import (
    configuration_from_row,
    summarize_batch_configurations,
)
from .agent_task_outcome import build_failure_breakdown, classify_run_outcome


def parse_trigger(
    run_metadata: dict[str, object] | None,
) -> AgentTaskRunTrigger | None:
    """Extract a run trigger view model from batch run metadata."""
    if not run_metadata:
        return None

    raw_trigger = run_metadata.get("trigger")
    if not isinstance(raw_trigger, dict):
        return None
    trigger_data = cast(dict[str, object], raw_trigger)

    initiated_at_raw = trigger_data.get("initiated_at")
    initiated_at: datetime | None = None
    if isinstance(initiated_at_raw, str):
        try:
            initiated_at = datetime.fromisoformat(
                initiated_at_raw.replace("Z", "+00:00")
            )
        except ValueError:
            initiated_at = None

    def _read(name: str) -> str | None:
        value = trigger_data.get(name)
        return value if isinstance(value, str) else None

    return AgentTaskRunTrigger(
        source=_read("source"),
        actor=_read("actor"),
        hostname=_read("hostname"),
        user_agent=_read("user_agent"),
        entrypoint=_read("entrypoint"),
        initiated_at=initiated_at,
        ci_system=_read("ci_system"),
        ci_run_id=_read("ci_run_id"),
        ci_run_url=_read("ci_run_url"),
        repository=_read("repository"),
        branch=_read("branch"),
        commit_sha=_read("commit_sha"),
        pr_number=_read("pr_number"),
        schedule_id=_read("schedule_id"),
        schedule_name=_read("schedule_name"),
    )


def to_task_run_summary(
    tr: AgentTaskRunDB,
    trigger: AgentTaskRunTrigger | None = None,
    primary_model: str | None = None,
) -> AgentTaskRunSummary:
    """Project a task run DB row to its summary view model.

    ``primary_model`` is the model used by the run's trace, looked up by
    the caller from ``RunDB`` via the run's ``trace_run_id``. It is a
    parameter (not read here) so this projection stays a pure function.
    """
    # the verdict is a persisted scalar projection; no need to load
    # the check evidence document to count verdicts.
    total_checks = tr.total_checks
    passed_checks = tr.passed_checks
    return AgentTaskRunSummary(
        id=tr.id,
        batch_run_id=tr.batch_run_id,
        task_id=tr.task_id,
        task_path=tr.task_path,
        adapter_name=tr.adapter_name,
        status=tr.status,
        pass_result=tr.pass_result,
        started_at=tr.started_at,
        completed_at=tr.completed_at,
        trace_run_id=tr.trace_run_id,
        primary_model=primary_model,
        task_source_commit_sha=tr.task_source_commit_sha,
        error_message=tr.error_message,
        trace_persistence_status=tr.trace_persistence_status,
        trace_error_message=tr.trace_error_message,
        total_cost=tr.total_cost,
        unpriced_call_count=tr.unpriced_call_count,
        total_checks=total_checks,
        passed_checks=passed_checks,
        failed_checks=max(total_checks - passed_checks, 0),
        trigger=trigger,
        error_category=classify_run_outcome(
            tr.status, tr.error_message, tr.trace_persistence_status
        ),
        run_configuration=configuration_from_row(
            tr.configured_model, tr.configured_effort
        ),
    )


def derive_selection_query(
    br: AgentTaskBatchRunDB, task_ids: Sequence[str]
) -> dict[str, object] | None:
    """The selection to project for a batch, derived when it stores none.

    A stored ``selection_query`` is the batch's resolved identity and always
    wins. Caller (CLI) batches created before that snapshot existed have none,
    which leaves the Runs list nothing to name them by except their selection
    type ("caller-task"). Their Task Runs still carry the canonical task ids,
    so the read model reconstructs the selection from the children.
    """
    if br.selection_query is not None:
        return br.selection_query
    paths = list(dict.fromkeys(task_id for task_id in task_ids if task_id))
    return {"task_paths": paths} if paths else None


def child_task_ids(task_runs: Sequence[AgentTaskRunDB]) -> list[str]:
    """Canonical task ids of a batch's children, in run order."""
    return [tr.task_id for tr in sorted(task_runs, key=lambda tr: (tr.sequence_index, tr.id))]


def to_batch_run_summary(
    br: AgentTaskBatchRunDB,
    total_cost: float | None = None,
    configuration: AgentTaskBatchRunConfigurationSummary | None = None,
    derived_task_ids: Sequence[str] = (),
) -> AgentTaskBatchRunSummary:
    """Project a batch run DB row to its summary view model.

    ``configuration`` is the derived Run Configuration summary for the batch's
    children. The list endpoint builds it from one grouped query across the
    page's batch IDs (no per-batch N+1); when omitted the batch projects as
    "unknown" configuration. ``derived_task_ids`` comes from that same query
    and only fills a missing ``selection_query`` (see
    ``derive_selection_query``).
    """
    trigger = parse_trigger(br.run_metadata)
    return AgentTaskBatchRunSummary(
        id=br.id,
        project=br.project,
        selection_type=br.selection_type,
        selection_query=derive_selection_query(br, derived_task_ids),
        task_root=br.task_root,
        grep=br.grep,
        environment=br.environment,
        status=br.status,
        total_tasks=br.total_tasks,
        passed_tasks=br.passed_tasks,
        failed_tasks=br.failed_tasks,
        errored_tasks=br.errored_tasks,
        total_checks=br.total_checks,
        passed_checks=br.passed_checks,
        trace_persistence_status=br.trace_persistence_status,
        trace_error_message=br.trace_error_message,
        total_cost=total_cost,
        created_at=br.created_at,
        started_at=br.started_at,
        completed_at=br.completed_at,
        trigger=trigger,
        configuration=configuration
        or AgentTaskBatchRunConfigurationSummary(state="unknown"),
    )


def to_batch_run_detail(
    br: AgentTaskBatchRunDB,
    task_runs: Sequence[AgentTaskRunDB],
    model_map: Mapping[str, str] | None = None,
    task_revision: TaskRevisionSummary | None = None,
    attempts: Sequence[TaskExecutionAttemptDB] = (),
    executor_names: Mapping[str, str] | None = None,
    executor_pool_name: str | None = None,
) -> AgentTaskBatchRunDetail:
    """Project a batch run DB row + its task runs to a detail view model.

    ``model_map`` maps a run's ``trace_run_id`` to its trace's
    ``primary_model``; when provided, each task run summary carries the
    model it ran under. Built by the caller from ``RunDB`` so this stays
    a pure function.
    """
    trigger = parse_trigger(br.run_metadata)
    task_run_summaries = [
        to_task_run_summary(
            tr,
            trigger,
            primary_model=model_map.get(tr.trace_run_id) if tr.trace_run_id and model_map else None,
        )
        for tr in task_runs
    ]
    total_cost = sum(tr.total_cost or 0 for tr in task_runs)
    breakdown = build_failure_breakdown(task_runs)
    execution_target = _execution_target(br.execution_target_json)
    is_source_owned = isinstance(execution_target, SourceOwnedExecutionTarget)
    waiting_reasons = _source_owned_waiting_reasons(
        br.project, attempts if is_source_owned else ()
    )
    configuration = summarize_batch_configurations(
        [
            configuration_from_row(tr.configured_model, tr.configured_effort)
            for tr in task_runs
        ],
        total_task_runs=len(task_runs),
    )
    # Source-owned Runs hide the internal canonical Pool and exact machine.
    # Legacy Pool Runs keep their resolved Pool name for historical detail.
    pool_name = None if is_source_owned else executor_pool_name
    return AgentTaskBatchRunDetail(
        id=br.id,
        project=br.project,
        selection_type=br.selection_type,
        selection_query=derive_selection_query(br, child_task_ids(task_runs)),
        task_root=br.task_root,
        grep=br.grep,
        environment=br.environment,
        run_metadata=br.run_metadata,
        status=br.status,
        total_tasks=br.total_tasks,
        passed_tasks=br.passed_tasks,
        failed_tasks=br.failed_tasks,
        errored_tasks=br.errored_tasks,
        cancelled_tasks=br.cancelled_tasks,
        total_checks=br.total_checks,
        passed_checks=br.passed_checks,
        trace_persistence_status=br.trace_persistence_status,
        trace_error_message=br.trace_error_message,
        total_cost=total_cost,
        created_at=br.created_at,
        started_at=br.started_at,
        completed_at=br.completed_at,
        trigger=trigger,
        task_runs=task_run_summaries,
        failure_breakdown=breakdown,
        task_revision=task_revision,
        execution_target=execution_target,
        executor_pool_name=pool_name,
        attempts=[
            _attempt_summary(
                attempt,
                executor_name=(
                    executor_names.get(attempt.executor_id)
                    if executor_names is not None and attempt.executor_id is not None
                    else None
                ),
                hide_internals=is_source_owned,
                waiting_reason=waiting_reasons.get(attempt.id),
            )
            for attempt in attempts
        ],
        configuration=configuration,
    )


def group_batch_configuration_summaries(
    task_runs: Sequence[AgentTaskRunDB],
) -> dict[str, AgentTaskBatchRunConfigurationSummary]:
    """Build per-batch configuration summaries from already-loaded child rows.

    Used by the batch list endpoint: it already loads all of the page's child
    task runs in one query (for cost rollup), so this reuses those in-memory
    rows to derive each batch's ``uniform``/``mixed``/``partial``/``unknown``
    summary without an N+1 per-batch query. Batches with no children present
    here project as ``unknown``.
    """
    by_batch: dict[str, list[AgentTaskRunConfiguration | None]] = {}
    totals: dict[str, int] = {}
    for tr in task_runs:
        bid = tr.batch_run_id
        by_batch.setdefault(bid, []).append(
            configuration_from_row(tr.configured_model, tr.configured_effort)
        )
        totals[bid] = totals.get(bid, 0) + 1
    return {
        bid: summarize_batch_configurations(rows, total_task_runs=totals[bid])
        for bid, rows in by_batch.items()
    }


def _execution_target(
    raw: dict[str, object] | None,
) -> ExecutionTarget | None:
    if raw is None:
        return None
    kind = raw.get("kind")
    if kind == "pool":
        pool_id = raw.get("pool_id")
        if isinstance(pool_id, str):
            return PoolExecutionTarget(kind="pool", pool_id=pool_id)
        return None
    if kind == "source_owned":
        return SourceOwnedExecutionTarget(kind="source_owned")
    return None


def _source_owned_waiting_reasons(
    project_id: str,
    attempts: Sequence[TaskExecutionAttemptDB],
) -> dict[str, AttemptWaitingReason]:
    """Compute the dynamic ``waiting_reason`` for queued source-owned Attempts.

    One aggregate computation per queued Attempt's ``target_user_id`` — the
    underlying service deduplicates across a User's Executors. Started or
    terminal Attempts return ``None`` (their phase/failure explains them).
    """
    from sqlmodel import Session

    from .connected_executor_status import compute_connected_environment_state

    reasons: dict[str, AttemptWaitingReason] = {}
    for attempt in attempts:
        if attempt.status != "queued" or not attempt.target_user_id:
            continue
        raw_session = Session.object_session(attempt)
        if raw_session is None:
            continue
        reasons[attempt.id] = compute_connected_environment_state(
            cast(Session, raw_session),
            project_id=project_id,
            user_id=attempt.target_user_id,
        )
    return reasons


def _attempt_summary(
    attempt: TaskExecutionAttemptDB,
    *,
    executor_name: str | None,
    hide_internals: bool = False,
    waiting_reason: AttemptWaitingReason | None = None,
) -> AttemptSummary:
    return AttemptSummary(
        id=attempt.id,
        task_run_id=attempt.task_run_id,
        status=cast(AttemptStatus, attempt.status),
        phase=cast(ExecutionPhase, attempt.phase) if attempt.phase else None,
        assignment_kind=cast(
            Literal["caller", "bundled", "source_owned"],
            attempt.assignment_kind or "bundled",
        ),
        executor_id=None if hide_internals else attempt.executor_id,
        executor_name=None if hide_internals else executor_name,
        executor_pool_id=None if hide_internals else attempt.executor_pool_id,
        driver_kind=None if hide_internals else attempt.driver_kind,
        queued_at=attempt.queued_at,
        queue_expires_at=attempt.queue_expires_at,
        waiting_reason=waiting_reason,
        claimed_at=attempt.claimed_at,
        started_at=attempt.started_at,
        heartbeat_at=attempt.heartbeat_at,
        completed_at=attempt.completed_at,
        failure_kind=attempt.failure_kind,
        error_message=attempt.error_message,
        cancel_requested_at=attempt.cancel_requested_at,
    )


__all__ = [
    "group_batch_configuration_summaries",
    "parse_trigger",
    "to_batch_run_detail",
    "to_batch_run_summary",
    "to_task_run_summary",
]
