"""Bounded projections of complete Task Run evidence.

Comparison pages resolve many immutable run ids at once. Loading them through
the single-run route creates one HTTP request and several database queries per
run. This service keeps that read inside one request and a fixed number of
queries, independent of the comparison size.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import cast

from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    TaskDefinitionRevisionDB,
)
from ..models.schemas import AgentTaskRunDetail, AgentTaskRunTrigger
from .agent_task_configuration import configuration_from_row
from .agent_task_outcome import classify_run_outcome
from .agent_task_projection import parse_trigger
from .check_report_storage import load_check_reports
from .task_definition_revisions import to_definition_summary


def load_task_run_details(
    session: Session,
    run_ids: Sequence[str],
    *,
    project_id: str,
) -> list[AgentTaskRunDetail]:
    """Return project-scoped details in requested-id order without N+1 reads."""
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

    return [
        _to_detail(
            run,
            trigger=triggers.get(run.batch_run_id),
            task_definition=definitions.get(run.task_definition_revision_id),
            checks=check_reports.get(run.id),
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
    run: AgentTaskRunDB,
    *,
    trigger: AgentTaskRunTrigger | None,
    task_definition: dict[str, object] | None,
    checks: list[dict[str, object]] | None,
) -> AgentTaskRunDetail:
    return AgentTaskRunDetail(
        id=run.id,
        batch_run_id=run.batch_run_id,
        task_id=run.task_id,
        task_path=run.task_path,
        adapter_name=run.adapter_name,
        status=run.status,
        pass_result=run.pass_result,
        started_at=run.started_at,
        completed_at=run.completed_at,
        trace_run_id=run.trace_run_id,
        task_source_commit_sha=run.task_source_commit_sha,
        error_message=run.error_message,
        trace_persistence_status=run.trace_persistence_status,
        trace_error_message=run.trace_error_message,
        total_cost=run.total_cost,
        unpriced_call_count=run.unpriced_call_count,
        total_tokens=run.total_tokens,
        total_checks=run.total_checks,
        passed_checks=run.passed_checks,
        failed_checks=run.failed_checks,
        trigger=trigger,
        checks_json=checks,
        transcript_json=None,
        deliverables_json=run.deliverables_json,
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
