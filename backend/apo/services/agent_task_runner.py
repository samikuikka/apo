"""
Agent task runner service.

Executes agent tasks and persists results as TaskRun rows.
"""

# pyright: reportPrivateUsage=false, reportUnusedFunction=false, reportUnusedImport=false, reportUnusedParameter=false

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import cast

from sqlmodel import Session, select

from ..auth.service_tokens import create_agent_task_trace_token
# `engine` is not referenced in this module, but tests monkeypatch it to swap
# in the test database.
from ..db import engine  # noqa: F401
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
)
from ..models.schemas import AgentTaskRunConfiguration
from .agent_task_configuration import normalize_run_configuration
from .archived_models import set_model_archived
from .lifecycle import TASK_RUN_TERMINAL
from .agent_task_discovery import DEFAULT_TASK_ROOT, resolve_task_paths
from .check_report_storage import persist_check_report
from .trace_backend import get_trace_backend
from .trace_ownership import (
    mark_pending,
    reconcile_trace_id,
    roll_up_batch,
)
from .project_task_source_sync import (
    refresh_filesystem_source,
    resolve_inventory_task_dir,
)
from .project_task_inventory import task_source_inventory_is_stale
from .run_events import emit_batch_run_event, emit_task_run_event

logger = logging.getLogger(__name__)

NO_CHECKS_REGISTERED_MESSAGE = (
    "No tests were registered by the eval module "
    "— a task must define at least one test()."
)

def _normalize_run_metadata(
    run_metadata: dict[str, object] | None,
) -> dict[str, object] | None:
    metadata = dict(run_metadata) if run_metadata else {}
    raw_trigger = metadata.get("trigger")
    trigger: dict[str, object] = (
        dict(cast(dict[str, object], raw_trigger))
        if isinstance(raw_trigger, dict)
        else {}
    )

    if not trigger:
        trigger = {"source": "api"}
    elif "source" not in trigger or not trigger["source"]:
        trigger["source"] = "api"

    metadata["trigger"] = trigger
    return metadata


def create_batch_run(
    session: Session,
    project: str,
    selection_type: str,
    task_paths: list[str] | None = None,
    task_root: str | None = None,
    grep: str | None = None,
    environment: str = "default",
    run_metadata: dict[str, object] | None = None,
    *,
    task_source: ProjectTaskSourceDB | None = None,
    commit: bool = True,
) -> AgentTaskBatchRunDB:
    """
    Create a batch run and its associated task run rows.

    Resolves the selection into concrete task paths and creates one
    TaskRun row per discovered task.

    when ``task_source`` is provided, snapshot its provenance
    (source type, ref, resolved commit SHA, subpath) onto the batch and
    each task run, and resolve inventory rows to populate
    ``task_inventory_id``. Legacy callers (no ``task_source``) get the
    legacy behaviour unchanged.
    """
    resolved_task_root = task_root or DEFAULT_TASK_ROOT
    inventory_rows: list[ProjectTaskInventoryDB] = []
    resolved = []

    if task_source is not None:
        if task_source.status != "ready":
            raise ValueError("Project task source is not ready. Sync tasks before running.")
        if task_source_inventory_is_stale(session, task_source):
            raise ValueError(
                "Project task inventory is stale because the task source changed. Sync tasks before running."
            )
        # Filesystem sources are cheap to re-scan (no clone), so lazily refresh
        # on run — makes "edit a task file, run it" work without a manual sync
        # (issue #17). Git/demo sources are intentionally not refreshed here.
        refresh_filesystem_source(session, task_source)
        inventory_rows = _resolve_inventory_rows(
            session,
            project=project,
            task_source=task_source,
            selection_type=selection_type,
            task_paths=task_paths,
            grep=grep,
        )
        if not inventory_rows:
            raise ValueError(_no_tasks_found_message(task_source))
    else:
        resolved = resolve_task_paths(resolved_task_root, selection_type, task_paths, grep)
        if not resolved:
            raise ValueError("No tasks found for the given selection")

    batch_id = uuid.uuid4().hex[:16]
    now = datetime.now(timezone.utc)

    batch = AgentTaskBatchRunDB(
        id=batch_id,
        project=project,
        selection_type=selection_type,
        selection_query={"task_paths": task_paths} if task_paths else None,
        task_root=resolved_task_root,
        grep=grep,
        environment=environment,
        run_metadata=_normalize_run_metadata(run_metadata),
        status="queued",
        total_tasks=len(inventory_rows) if task_source is not None else len(resolved),
        created_at=now,
        task_source_type=task_source.source_type if task_source else None,
        task_source_ref=_source_ref_value(task_source),
        task_source_commit_sha=(
            task_source.last_resolved_commit_sha if task_source else None
        ),
        task_source_subpath=task_source.subpath if task_source else None,
    )
    session.add(batch)

    if task_source is not None:
        for inventory_row in inventory_rows:
            task_run_id = uuid.uuid4().hex[:16]
            runtime_task_dir = resolve_inventory_task_dir(
                session,
                task_source,
                inventory_row.task_path,
                resolved_commit_sha=batch.task_source_commit_sha,
            )
            task_run = AgentTaskRunDB(
                id=task_run_id,
                batch_run_id=batch_id,
                task_id=inventory_row.task_id,
                task_path=str(runtime_task_dir),
                adapter_name=inventory_row.adapter_name,
                status="pending",
                task_inventory_id=inventory_row.id,
                task_source_commit_sha=batch.task_source_commit_sha,
            )
            session.add(task_run)
    else:
        inventory_by_task_id = _load_inventory_for_batch(session, project, task_source)
        for resolved_task in resolved:
            task_run_id = uuid.uuid4().hex[:16]
            inventory_row = inventory_by_task_id.get(resolved_task.task_id)
            task_run = AgentTaskRunDB(
                id=task_run_id,
                batch_run_id=batch_id,
                task_id=resolved_task.task_id,
                task_path=resolved_task.task_path,
                status="pending",
                task_inventory_id=inventory_row.id if inventory_row else None,
                task_source_commit_sha=batch.task_source_commit_sha,
            )
            session.add(task_run)

    if commit:
        session.commit()
        session.refresh(batch)
    else:
        session.flush()
    return batch


def _source_ref_value(source: ProjectTaskSourceDB | None) -> str | None:
    """Return the human-readable ref for the source, or ``None``."""
    if source is None:
        return None
    if source.source_type == "git":
        return source.git_ref
    if source.source_type == "filesystem":
        return source.filesystem_path
    if source.source_type == "demo":
        return source.demo_seed_id
    return None


def _load_inventory_for_batch(
    session: Session,
    project: str,
    task_source: ProjectTaskSourceDB | None,
) -> dict[str, ProjectTaskInventoryDB]:
    """Look up inventory rows keyed by ``task_id`` for the project/source.

    Returns an empty dict when no source is provided (legacy callers),
    so ``task_inventory_id`` stays ``None`` on the new task run rows.
    """
    if task_source is None:
        return {}
    statement = select(ProjectTaskInventoryDB).where(
        ProjectTaskInventoryDB.project == project,
        ProjectTaskInventoryDB.task_source_id == task_source.id,
    )
    rows = session.exec(statement).all()
    return {row.task_id: row for row in rows}


def _resolve_inventory_rows(
    session: Session,
    *,
    project: str,
    task_source: ProjectTaskSourceDB,
    selection_type: str,
    task_paths: list[str] | None,
    grep: str | None,
) -> list[ProjectTaskInventoryDB]:
    """Resolve a batch selection against persisted project inventory."""
    statement = select(ProjectTaskInventoryDB).where(
        ProjectTaskInventoryDB.project == project,
        ProjectTaskInventoryDB.task_source_id == task_source.id,
    )
    all_rows = list(session.exec(statement).all())

    if grep:
        needle = grep.lower()
        all_rows = [
            row
            for row in all_rows
            if needle in row.task_id.lower()
            or needle in row.display_name.lower()
            or needle in row.folder_path.lower()
        ]

    if selection_type == "all":
        return all_rows

    if selection_type in ("task", "tasks"):
        if not task_paths:
            return []
        wanted = set(task_paths)
        return [
            row
            for row in all_rows
            if row.task_id in wanted or row.task_path in wanted
        ]

    if selection_type == "folder":
        if not task_paths:
            return []
        folders = list(task_paths)
        return [
            row
            for row in all_rows
            if any(
                row.folder_path.startswith(folder) or row.task_path.startswith(folder)
                for folder in folders
            )
        ]

    return []


def _no_tasks_found_message(task_source: ProjectTaskSourceDB) -> str:
    """Actionable "no tasks" message (issue #17).

    Filesystem sources are lazily re-synced on run, so if the selection still
    matches nothing the task genuinely isn't on disk. Other sources (git/demo)
    are not auto-refreshed, so the most useful nudge is to run a sync.
    """
    if task_source.source_type == "filesystem":
        return (
            "No tasks found for the given selection. The filesystem source was "
            "re-scanned and no matching task exists on disk."
        )
    return (
        "No tasks found for the given selection. If you recently added or "
        "renamed a task, run `apo project source sync` to refresh the project "
        "inventory."
    )


def update_batch_run_status(session: Session, batch: AgentTaskBatchRunDB) -> None:
    """Recalculate batch aggregate counters from its task runs."""
    task_runs = session.exec(
        select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
    ).all()

    batch.total_tasks = len(task_runs)
    batch.passed_tasks = sum(1 for tr in task_runs if tr.status == "passed")
    batch.failed_tasks = sum(1 for tr in task_runs if tr.status == "failed")
    batch.errored_tasks = sum(1 for tr in task_runs if tr.status == "error")
    # Check-level rollup — the "how well did it do" metric. Mirrors
    # to_task_run_summary's per-task logic so batch and child rows agree.
    # sums the persisted scalar columns; never loads the check
    # evidence document.
    batch.total_checks = sum(tr.total_checks for tr in task_runs)
    batch.passed_checks = sum(tr.passed_checks for tr in task_runs)

    all_done = all(tr.status in TASK_RUN_TERMINAL for tr in task_runs)
    if all_done and task_runs:
        batch.status = "completed"
        batch.completed_at = datetime.now(timezone.utc)
    elif any(tr.status in ("running", "pending") for tr in task_runs):
        batch.status = "running"
        if batch.started_at is None:
            batch.started_at = datetime.now(timezone.utc)

    roll_up_batch(batch, task_runs)

    session.add(batch)
    session.commit()
    session.refresh(batch)


def _update_adaptive_state_if_needed(
    session: Session, batch: AgentTaskBatchRunDB
) -> None:
    """Update adaptive schedule states after a batch completes or errors.

    No-op for batches that were not triggered by a schedule (direct API
    runs) or whose schedule uses a fixed cadence. The lazy import avoids a
    circular dependency with ``adaptive_scheduler``.
    """
    schedule_id = _extract_schedule_id_from_batch(batch)
    if schedule_id is None:
        return
    schedule = session.get(AgentTaskScheduleDB, schedule_id)
    if schedule is None or schedule.cadence_type != "adaptive":
        return
    try:
        from .adaptive_scheduler import update_adaptive_state_after_batch

        update_adaptive_state_after_batch(session, schedule, batch)
    except Exception:
        logger.exception(
            "Failed to update adaptive state for batch %s", batch.id
        )


def _extract_schedule_id_from_batch(batch: AgentTaskBatchRunDB) -> str | None:
    metadata = batch.run_metadata
    if not metadata:
        return None
    schedule_meta = metadata.get("schedule")
    if not isinstance(schedule_meta, dict):
        return None
    schedule_id = cast(dict[str, object], schedule_meta).get("id")
    return schedule_id if isinstance(schedule_id, str) else None


def finalize_task_run_with_result(
    session: Session,
    task_run: AgentTaskRunDB,
    batch: AgentTaskBatchRunDB,
    *,
    adapter_name: str | None,
    pass_result: bool,
    trace_run_id: str | None,
    checks: list[dict[str, object]] | None,
    transcript: dict[str, object] | None,
    deliverables: dict[str, object] | None,
    errored: bool = False,
    error_message: str | None = None,
    run_configuration: AgentTaskRunConfiguration | None = None,
) -> None:
    """Write an executor's result onto a task run and roll up the batch.

    Shared between the external-result path and the executor protocol.
    and external execution (``POST /v1/agent-task-runs/{id}/result``). Does
    NOT set ``completed_at`` or emit events — callers own those because the
    surrounding lifecycle differs (subprocess already has the row locked in
    its own session; external route commits + emits in one shot).

    ``error_message`` precedence (Issue #8): a caller-supplied message wins;
    otherwise a failed run with zero registered checks gets the no-tests
    notice (so the row explains itself instead of looking like a real check
    failure); otherwise it's cleared (a real success has no error).

    ``errored`` (Issue #13) overrides the verdict: the executor threw before
    producing a result, so the run lands as ``status: error`` with the
    caller-supplied message preserved — ahead of the Issue #8 precedence,
    which only applies to ``passed``/``failed`` verdicts.

    ``run_configuration``: the adapter's resolved model/effort.
    Validated before any terminal state is mutated — an invalid reported
    configuration is an adapter contract error (``ValueError``) and must not
    partially mutate the row. Persisted as the typed/indexed
    ``configured_model`` / ``configured_effort`` columns.
    """
    # validate before mutating terminal state.
    normalized_config = normalize_run_configuration(run_configuration)

    # No Artifact may still be pending or failed when the run
    # terminalizes. Checks finish and uploads complete before result submission.
    _reject_non_ready_artifacts(session, task_run.id)

    task_run.adapter_name = adapter_name
    task_run.pass_result = pass_result
    task_run.trace_run_id = reconcile_trace_id(task_run, trace_run_id)
    # persist the typed, indexed configuration columns. Absent
    # (None) when the adapter did not report a configuration.
    task_run.configured_model = (
        normalized_config.model if normalized_config else None
    )
    task_run.configured_effort = (
        normalized_config.effort if normalized_config else None
    )
    # A fresh run means the label is live again, so it comes back to the filter
    # dropdowns on its own — otherwise you would run an archived model and have
    # no way to filter for it without knowing to go un-archive it first.
    if normalized_config and normalized_config.model:
        set_model_archived(
            session, batch.project, normalized_config.model, archived=False
        )
    # persist the scalar verdict onto the run row and the full check
    # evidence into ``agent_task_check_reports`` (off the hot row). Stages on the
    # session; the caller's transaction commits so scalars + report land
    # together. Direct service calls and tests cannot bypass this — every
    # finalized run has correct counts and a bounded, un-shrunk report.
    persist_check_report(session, task_run, checks)
    # ``transcript_json`` is still written (no replacement storage yet).
    # Deliverables persist as rows at every entry point; the legacy
    # ``deliverables_json`` column was dropped in schema v28.
    task_run.transcript_json = transcript
    trace_backend = get_trace_backend(batch.project)
    trace_backend.aggregate_costs(session, task_run, batch.project)
    trace_backend.confirm_and_link(session, task_run, batch.project)
    if errored:
        # The executor threw, not the judge — preserve the message so the
        # dashboard shows *why* the run died. This wins over the Issue #8
        # precedence below, which only applies to passed/failed verdicts.
        task_run.status = "error"
        task_run.error_message = error_message
        # #154: no judge produced a verdict, so none may be stored — an
        # error run must not render as FAIL.
        task_run.pass_result = None
    elif _generation_errors_dominate(task_run.generation_execution_json):
        # Issue #149: the checks ran, but they evaluated an execution dominated
        # by failed model calls. Preserve the Check Report as diagnostics while
        # refusing to turn it into a misleading PASS/FAIL control signal.
        task_run.pass_result = None
        task_run.status = "error"
        generation_execution = task_run.generation_execution_json
        assert generation_execution is not None
        task_run.error_message = _generation_execution_error_message(generation_execution)
    else:
        task_run.status = "passed" if task_run.pass_result else "failed"
        task_run.error_message = _resolve_run_error_message(
            pass_result=task_run.pass_result,
            checks=checks,
            error_message=error_message,
        )


def _generation_errors_dominate(summary: dict[str, object] | None) -> bool:
    if summary is None:
        return False
    total = summary.get("total")
    errored = summary.get("errored")
    return (
        isinstance(total, int)
        and not isinstance(total, bool)
        and isinstance(errored, int)
        and not isinstance(errored, bool)
        and total > 0
        and errored * 2 > total
    )


def _generation_execution_error_message(summary: dict[str, object]) -> str:
    total = summary.get("total")
    errored = summary.get("errored")
    return (
        f"{errored} of {total} generations ended in error. "
        "No PASS/FAIL verdict was recorded; checks remain diagnostic evidence."
    )


def _reject_non_ready_artifacts(session: Session, task_run_id: str) -> None:
    """A result cannot terminalize while an Artifact
    is still pending or failed. Returns silently when all Artifacts are ready
    or there are none.

    Locks the Task Run row (SELECT ... FOR UPDATE) to serialize with
    concurrent intent creation / PUT completion."""
    from ..models.db import AgentTaskDeliverableDB
    from sqlmodel import col
    from .agent_task_deliverables import lock_task_run

    # Acquire the fence so a concurrent intent cannot land between the check
    # and the terminal mutation.
    _locked = lock_task_run(session, task_run_id)
    if _locked is None:
        return  # Task Run deleted — the finalizer's caller handles missing runs

    blocked = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == task_run_id,
            AgentTaskDeliverableDB.kind == "artifact",
            col(AgentTaskDeliverableDB.status).in_(("pending", "failed")),
        )
    ).first()
    if blocked is not None:
        raise ValueError(
            f"Task Run has non-ready Artifacts: {blocked.name} (status={blocked.status})"
        )


def _resolve_run_error_message(
    *,
    pass_result: bool,
    checks: list[dict[str, object]] | None,
    error_message: str | None,
) -> str | None:
    """Pick the error_message to persist for a finalized run.

    - Passing runs never carry an error (don't fabricate one for an empty-but-
      passing run).
    - A caller-supplied message (e.g. the executor's caught exception, or an
      externally-reported error_message) always wins.
    - A failed run with no checks is a registration bug — surface the notice.
    - Otherwise clear it: a real check failure speaks for itself via checks_json.
    """
    if pass_result:
        return None
    if error_message:
        return error_message
    if not checks:
        return NO_CHECKS_REGISTERED_MESSAGE
    return None


def prepare_external_batch_runs(
    session: Session,
    batch: AgentTaskBatchRunDB,
) -> list[tuple[AgentTaskRunDB, str]]:
    """Mark each task run as ``running`` and mint a scoped trace token.

    Called by ``POST /v1/agent-task-batch-runs/external`` after the batch is
    created. Returns ``(task_run, token)`` pairs so the route can surface the
    tokens to the external executor (e.g. the CLI ``--local`` flag). Does NOT
    spawn a subprocess — the executor runs out-of-band and reports results
    via ``POST /v1/agent-task-runs/{id}/result``.
    """
    task_runs = session.exec(
        select(AgentTaskRunDB)
        .where(AgentTaskRunDB.batch_run_id == batch.id)
        .order_by(AgentTaskRunDB.id)
    ).all()

    now = datetime.now(timezone.utc)
    batch.status = "running"
    batch.started_at = batch.started_at or now
    session.add(batch)

    pairs: list[tuple[AgentTaskRunDB, str]] = []
    for task_run in task_runs:
        task_run.status = "running"
        task_run.started_at = now
        mark_pending(task_run)
        session.add(task_run)
        token = create_agent_task_trace_token(
            task_run_id=task_run.id,
            project=batch.project,
            expires_in_seconds=_external_token_ttl_seconds(),
        )
        pairs.append((task_run, token))

    session.commit()
    for task_run, _token in pairs:
        session.refresh(task_run)
    session.refresh(batch)
    return pairs


def finalize_external_task_run(
    session: Session,
    task_run: AgentTaskRunDB,
    *,
    pass_result: bool,
    adapter_name: str | None,
    trace_run_id: str | None,
    checks: list[dict[str, object]] | None,
    transcript: dict[str, object] | None,
    deliverables: dict[str, object] | None,
    errored: bool = False,
    error_message: str | None = None,
    run_configuration: AgentTaskRunConfiguration | None = None,
) -> None:
    """Apply an external executor's final result to a task run.

    Used by ``POST /v1/agent-task-runs/{id}/result``. Sets terminal state,
    rolls up the batch, and emits the same events as the subprocess path so
    the dashboard treats the run identically. Raises ``ValueError`` (mapped
    to 409 by the route) if the run is already terminal.

    ``error_message`` flows through to ``finalize_task_run_with_result`` so an
    externally-reported failure reason is persisted (Issue #8). ``errored``
    flows through so an executor that threw lands as ``status: error`` with
    that message, ahead of the Issue #8 precedence (Issue #13).
    ``run_configuration`` flows through to the shared finalizer,
    which validates it before persisting; an invalid configuration raises
    ``ValueError`` (mapped to 400 by the route, since the terminal-check above
    has already passed).
    """
    if task_run.status in TASK_RUN_TERMINAL:
        raise ValueError(
            f"Task run {task_run.id} is already terminal (status={task_run.status})"
        )

    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is None:
        raise ValueError(f"Batch run {task_run.batch_run_id} not found for task run {task_run.id}")

    finalize_task_run_with_result(
        session,
        task_run,
        batch,
        adapter_name=adapter_name,
        pass_result=pass_result,
        trace_run_id=trace_run_id,
        checks=checks,
        transcript=transcript,
        deliverables=deliverables,
        errored=errored,
        error_message=error_message,
        run_configuration=run_configuration,
    )
    task_run.completed_at = datetime.now(timezone.utc)
    session.add(task_run)
    session.commit()
    session.refresh(batch)

    emit_task_run_event(batch.project, task_run)
    update_batch_run_status(session, batch)

    if batch.status in ("completed", "error"):
        task_runs = list(
            session.exec(
                select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
            ).all()
        )
        emit_batch_run_event(batch.project, batch, task_runs)


def _external_token_ttl_seconds() -> int:
    """TTL for external-execution trace tokens.

    External runs (e.g. ``apo task run --local``) may take longer than the
    default 15-minute subprocess token — they touch dev-machine credentials,
    VPC tunnels, and personal stages. The TTL gates only trace ingestion
    during execution; reporting the result uses regular project auth.
    """
    raw = os.environ.get("APO_EXTERNAL_TASK_TOKEN_TTL")
    if raw and raw.isdigit():
        return int(raw)
    return 2 * 60 * 60  # 2 hours


_TASK_ENV_DENY_LIST = frozenset(
    {
        "AUTH_SECRET",
        "DATABASE_URL",
        "POSTGRES_PASSWORD",
        "ADMIN_API_KEY",
        "API_KEY_SALT",
        "EMAIL_TRANSPORT_URL",
        "GITHUB_CLIENT_SECRET",
        "GITHUB_TOKEN_ENCRYPTION_KEY",
    }
)

# Process essentials required for Node/Python to start and create temp
# files. Inherited from the backend process; safe to surface to tasks.
_TASK_ENV_PROCESS_ESSENTIALS = frozenset(
    {"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "USER", "SHELL"}
)

# Provider/model variables the packaged task runtime reads. These are
# operator-granted task credentials, so they are intentionally passed.
_TASK_ENV_PROVIDER_VARS = (
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    # Claude Agent SDK subprocess auth (ANTHROPIC_API_KEY for real Anthropic,
    # ANTHROPIC_AUTH_TOKEN for ZAI-compatible endpoints, CLAUDE_MODEL override).
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_MODEL",
    "AGENT_TASK_JUDGE_MODEL",
    "AGENT_TASK_OPENROUTER_MODEL",
)
