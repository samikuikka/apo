"""Bounded projections of complete Task Run evidence.

Comparison pages resolve many immutable run ids at once. Loading them through
the single-run route creates one HTTP request and several database queries per
run. This service keeps that read inside one request and a fixed number of
queries, independent of the comparison size.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import cast

from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    TaskDefinitionRevisionDB,
)
from ..models.schemas import (
    AgentTaskRunDetail,
    AgentTaskRunSummary,
    AgentTaskRunTrigger,
    GenerationExecutionSummary,
    GenerationUsageSummary,
    as_task_run_status,
    as_trace_persistence_status,
)
from .agent_task_configuration import configuration_from_row
from .agent_task_deliverables import derive_deliverables_json_for_runs
from .agent_task_outcome import classify_run_outcome
from .agent_task_projection import parse_trigger
from .check_report_storage import load_check_reports
from .task_definition_revisions import to_definition_summary
from .test_result_corrections import (
    effective_check_report,
    load_corrections,
    resolve_actor_labels,
)


def load_task_run_summaries(
    session: Session,
    run_ids: Sequence[str],
    *,
    project_id: str,
) -> list[AgentTaskRunSummary]:
    """Return project-scoped scalar summaries in requested-id order.

    Never loads Check Reports, Task Definition bodies, transcripts, or legacy
    Deliverable JSON. Used by the comparison overview route so the response
    size grows with summary count, not evidence-body size.
    """
    unique_ids = list(dict.fromkeys(run_ids))
    if not unique_ids:
        return []

    runs = session.exec(
        select(AgentTaskRunDB)
        .join(AgentTaskBatchRunDB)
        .where(
            col(AgentTaskRunDB.id).in_(unique_ids),
            AgentTaskBatchRunDB.project == project_id,
        )
        .options(
            defer(AgentTaskRunDB.transcript_json),  # pyright: ignore[reportArgumentType]
        )
    ).all()
    run_by_id = {run.id: run for run in runs}
    triggers = _load_triggers(session, runs)

    return [
        _to_summary(
            run,
            trigger=triggers.get(run.batch_run_id),
        )
        for run_id in unique_ids
        if (run := run_by_id.get(run_id)) is not None
    ]


def _to_summary(
    run: AgentTaskRunDB,
    *,
    trigger: AgentTaskRunTrigger | None,
) -> AgentTaskRunSummary:
    return AgentTaskRunSummary(
        id=run.id,
        batch_run_id=run.batch_run_id,
        task_id=run.task_id,
        task_path=run.task_path,
        adapter_name=run.adapter_name,
        status=as_task_run_status(run.status),
        pass_result=run.pass_result,
        started_at=run.started_at,
        completed_at=run.completed_at,
        trace_run_id=run.trace_run_id,
        task_source_commit_sha=run.task_source_commit_sha,
        error_message=run.error_message,
        trace_persistence_status=as_trace_persistence_status(
            run.trace_persistence_status
        ),
        trace_error_message=run.trace_error_message,
        total_cost=run.total_cost,
        unpriced_call_count=run.unpriced_call_count,
        generation_execution=_generation_execution_summary(run),
        generation_usage=_generation_usage_summary(run),
        total_tokens=run.total_tokens,
        # Issue #309 reasoning + timing rollups (see AgentTaskRunSummary).
        total_reasoning_tokens=run.total_reasoning_tokens,
        max_call_reasoning_tokens=run.max_call_reasoning_tokens,
        max_call_reasoning_call_id=run.max_call_reasoning_call_id,
        max_call_latency_ms=run.max_call_latency_ms,
        max_call_latency_call_id=run.max_call_latency_call_id,
        total_model_time_ms=run.total_model_time_ms,
        total_checks=run.total_checks,
        passed_checks=run.passed_checks,
        failed_checks=run.failed_checks,
        corrected_tests=run.corrected_tests,
        trigger=trigger,
        error_category=classify_run_outcome(
            run.status,
            run.error_message,
            run.trace_persistence_status,
        ),
        run_configuration=configuration_from_row(
            run.configured_model,
            run.configured_effort,
        ),
    )


def load_task_run_details(
    session: Session,
    run_ids: Sequence[str],
    *,
    project_id: str,
    corrections_as_of: datetime | None = None,
) -> list[AgentTaskRunDetail]:
    """Return project-scoped details in requested-id order without N+1 reads.

    ``corrections_as_of`` projects each run's checks as they were effective
    at that instant (comparison evidence for frozen snapshots); the default
    projects the current effective state. Check Reports themselves are never
    rewritten — the overlay happens in memory.
    """
    unique_ids = list(dict.fromkeys(run_ids))
    if not unique_ids:
        return []

    runs = session.exec(
        select(AgentTaskRunDB)
        .join(AgentTaskBatchRunDB)
        .where(
            col(AgentTaskRunDB.id).in_(unique_ids),
            AgentTaskBatchRunDB.project == project_id,
        )
        .options(
            defer(AgentTaskRunDB.transcript_json),  # pyright: ignore[reportArgumentType]
        )
    ).all()
    run_by_id = {run.id: run for run in runs}
    triggers = _load_triggers(session, runs)
    definitions = _load_definitions(session, runs)
    check_reports = load_check_reports(session, runs)

    # One bulk corrections query for all runs, then in-memory
    # overlay per run — no N+1.
    corrections_by_run = load_corrections(session, unique_ids)
    labels = resolve_actor_labels(
        session,
        [c for rows in corrections_by_run.values() for c in rows],
    )

    derived = derive_deliverables_json_for_runs(session, list(run_by_id.values()))
    return [
        _to_detail(
            session,
            run,
            trigger=triggers.get(run.batch_run_id),
            task_definition=definitions.get(run.task_definition_revision_id),
            checks=effective_check_report(
                check_reports.get(run.id) or [],
                corrections_by_run.get(run.id, []),
                as_of=corrections_as_of,
                actor_labels=labels,
            )
            or None,
            deliverables_json=derived.get(run.id),
        )
        for run_id in unique_ids
        if (run := run_by_id.get(run_id)) is not None
    ]


def _load_triggers(
    session: Session,
    runs: Sequence[AgentTaskRunDB],
) -> dict[str, AgentTaskRunTrigger | None]:
    batch_ids = list(dict.fromkeys(run.batch_run_id for run in runs))
    if not batch_ids:
        return {}
    batches = session.exec(
        select(AgentTaskBatchRunDB).where(
            col(AgentTaskBatchRunDB.id).in_(batch_ids)
        )
    ).all()
    return {batch.id: parse_trigger(batch.run_metadata) for batch in batches}


def _load_definitions(
    session: Session,
    runs: Sequence[AgentTaskRunDB],
) -> dict[str | None, dict[str, object]]:
    revision_ids = list(
        dict.fromkeys(
            run.task_definition_revision_id
            for run in runs
            if run.task_definition_revision_id is not None
        )
    )
    if not revision_ids:
        return {}
    revisions = session.exec(
        select(TaskDefinitionRevisionDB).where(
            col(TaskDefinitionRevisionDB.id).in_(revision_ids)
        )
    ).all()
    return {revision.id: cast(dict[str, object], to_definition_summary(revision)) for revision in revisions}


def _to_detail(
    _session: Session,
    run: AgentTaskRunDB,
    *,
    trigger: AgentTaskRunTrigger | None,
    task_definition: dict[str, object] | None,
    checks: list[dict[str, object]] | None,
    deliverables_json: dict[str, object] | None = None,
) -> AgentTaskRunDetail:
    return AgentTaskRunDetail(
        id=run.id,
        batch_run_id=run.batch_run_id,
        task_id=run.task_id,
        task_path=run.task_path,
        adapter_name=run.adapter_name,
        status=as_task_run_status(run.status),
        pass_result=run.pass_result,
        started_at=run.started_at,
        completed_at=run.completed_at,
        trace_run_id=run.trace_run_id,
        task_source_commit_sha=run.task_source_commit_sha,
        error_message=run.error_message,
        trace_persistence_status=as_trace_persistence_status(
            run.trace_persistence_status
        ),
        trace_error_message=run.trace_error_message,
        total_cost=run.total_cost,
        unpriced_call_count=run.unpriced_call_count,
        generation_execution=_generation_execution_summary(run),
        generation_usage=_generation_usage_summary(run),
        total_tokens=run.total_tokens,
        # Issue #309 reasoning + timing rollups (see AgentTaskRunSummary).
        total_reasoning_tokens=run.total_reasoning_tokens,
        max_call_reasoning_tokens=run.max_call_reasoning_tokens,
        max_call_reasoning_call_id=run.max_call_reasoning_call_id,
        max_call_latency_ms=run.max_call_latency_ms,
        max_call_latency_call_id=run.max_call_latency_call_id,
        total_model_time_ms=run.total_model_time_ms,
        total_checks=run.total_checks,
        passed_checks=run.passed_checks,
        failed_checks=run.failed_checks,
        corrected_tests=run.corrected_tests,
        trigger=trigger,
        checks_json=checks,
        transcript_json=None,
        deliverables_json=deliverables_json,
        error_category=classify_run_outcome(
            run.status,
            run.error_message,
            run.trace_persistence_status,
        ),
        run_configuration=configuration_from_row(
            run.configured_model,
            run.configured_effort,
        ),
        task_definition=task_definition,
    )


def _generation_execution_summary(
    run: AgentTaskRunDB,
) -> GenerationExecutionSummary | None:
    if run.generation_execution_json is None:
        return None
    return GenerationExecutionSummary.model_validate(run.generation_execution_json)


def _generation_usage_summary(run: AgentTaskRunDB) -> GenerationUsageSummary | None:
    if run.generation_usage_json is None:
        return None
    return GenerationUsageSummary.model_validate(run.generation_usage_json)
