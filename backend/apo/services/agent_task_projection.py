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
from typing import cast

from ..models import (
    AgentTaskBatchRunDB,
    AgentTaskBatchRunDetail,
    AgentTaskBatchRunSummary,
    AgentTaskRunDB,
    AgentTaskRunTrigger,
    AgentTaskRunSummary,
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
    total_checks = len(tr.checks_json or [])
    passed_checks = sum(
        1 for result in (tr.checks_json or []) if result.get("pass") is True
    )
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
        total_checks=total_checks,
        passed_checks=passed_checks,
        failed_checks=max(total_checks - passed_checks, 0),
        trigger=trigger,
        error_category=classify_run_outcome(
            tr.status, tr.error_message, tr.trace_persistence_status
        ),
    )


def to_batch_run_summary(
    br: AgentTaskBatchRunDB, total_cost: float | None = None
) -> AgentTaskBatchRunSummary:
    """Project a batch run DB row to its summary view model."""
    trigger = parse_trigger(br.run_metadata)
    return AgentTaskBatchRunSummary(
        id=br.id,
        project=br.project,
        selection_type=br.selection_type,
        selection_query=br.selection_query,
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
    )


def to_batch_run_detail(
    br: AgentTaskBatchRunDB,
    task_runs: Sequence[AgentTaskRunDB],
    model_map: Mapping[str, str] | None = None,
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
    return AgentTaskBatchRunDetail(
        id=br.id,
        project=br.project,
        selection_type=br.selection_type,
        selection_query=br.selection_query,
        task_root=br.task_root,
        grep=br.grep,
        environment=br.environment,
        run_metadata=br.run_metadata,
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
        task_runs=task_run_summaries,
        failure_breakdown=breakdown,
    )


__all__ = [
    "parse_trigger",
    "to_batch_run_detail",
    "to_batch_run_summary",
    "to_task_run_summary",
]
