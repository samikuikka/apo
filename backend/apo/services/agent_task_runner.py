# pyright: reportPrivateUsage=false

"""
Agent task runner service.

Executes agent tasks and persists results as TaskRun rows.
"""

import json
import logging
import os
import subprocess
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import cast

from sqlmodel import Session, select

from ..auth.service_tokens import create_agent_task_trace_token
from ..db import engine
from ..db_helpers import _as_column
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
)
from .agent_task_discovery import DEFAULT_TASK_ROOT, resolve_task_paths
from .trace_backend import get_trace_backend
from .trace_ownership import (
    mark_failed,
    mark_pending,
    reconcile_trace_id,
    roll_up_batch,
)
from .project_task_source_sync import resolve_inventory_task_dir
from .project_task_inventory import task_source_inventory_is_stale
from .run_events import emit_batch_run_event, emit_task_run_event

logger = logging.getLogger(__name__)

TASK_SUBPROCESS_TIMEOUT_SECONDS = 600

# Issue #8: stored on task_run.error_message when a run ends failed with zero
# registered checks. Naming test() matches the documented registration fn
# (apps/docs reference/task.md). Kept in sync with the SDK/CLI copies in
# packages/sdk/src/agent-task/run/aggregate.ts and
# packages/cli/src/lib/checks-format.ts — the wording is part of the UX contract.
NO_CHECKS_REGISTERED_MESSAGE = (
    "No tests were registered by the eval module "
    "— a task must define at least one test()."
)

# ---------------------------------------------------------------------------
# SPEC-132 Behavior 7: bounded batch execution pool.
#
# A single in-process ThreadPoolExecutor caps how many batches run at once.
# When the pool is saturated, executor.submit() queues internally — no extra
# worker threads are spawned, which is the whole point on a small host.
# min 1, max 8, default 1 (see runtime_config._max_concurrent_batches).
# ---------------------------------------------------------------------------


def _safe_parse_int(raw: str, fallback: int) -> int:
    try:
        return int(raw)
    except ValueError:
        return fallback


def _clamp_concurrency(raw: str) -> int:
    """Parse and clamp the concurrency env value to [1, 8]."""
    return max(1, min(8, _safe_parse_int(raw, 1)))


_batch_pool_limit: int = _clamp_concurrency(
    os.environ.get("AGENT_TASK_MAX_CONCURRENT_BATCHES", "")
)
_batch_pool_executor: ThreadPoolExecutor | None = None
_batch_pool_lock = threading.Lock()


def get_max_concurrent_batches() -> int:
    """The configured batch concurrency limit (1–8)."""
    return _batch_pool_limit


def _configure_batch_pool_limit(limit: int) -> None:  # pyright: ignore[reportUnusedFunction]
    """Override the concurrency limit and reset the pool.

    Used by tests to exercise different limits without reloading the
    module (which would pollute other tests' monkeypatches). Production
    code reads the limit once at import from ``AGENT_TASK_MAX_CONCURRENT_BATCHES``.
    """
    global _batch_pool_limit, _batch_pool_executor
    with _batch_pool_lock:
        _batch_pool_limit = max(1, min(8, limit))
        if _batch_pool_executor is not None:
            _batch_pool_executor.shutdown(wait=False)
            _batch_pool_executor = None


def _batch_pool() -> ThreadPoolExecutor:
    """Lazily initialize the process-wide batch execution pool."""
    global _batch_pool_executor
    if _batch_pool_executor is None:
        with _batch_pool_lock:
            if _batch_pool_executor is None:
                _batch_pool_executor = ThreadPoolExecutor(
                    max_workers=_batch_pool_limit,
                    thread_name_prefix="agent-task-batch",
                )
    return _batch_pool_executor


def _log_batch_pool_failure(future: Future[None]) -> None:
    """ThreadPoolExecutor submit hook: surface unexpected exceptions."""
    exc = future.exception()
    if exc is not None:
        logger.exception("Batch pool task crashed", exc_info=exc)


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
) -> AgentTaskBatchRunDB:
    """
    Create a batch run and its associated task run rows.

    Resolves the selection into concrete task paths and creates one
    TaskRun row per discovered task.

    SPEC-119: when ``task_source`` is provided, snapshot its provenance
    (source type, ref, resolved commit SHA, subpath) onto the batch and
    each task run, and resolve inventory rows to populate
    ``task_inventory_id``. Legacy callers (no ``task_source``) get the
    pre-SPEC-119 behaviour unchanged.
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
        inventory_rows = _resolve_inventory_rows(
            session,
            project=project,
            task_source=task_source,
            selection_type=selection_type,
            task_paths=task_paths,
            grep=grep,
        )
        if not inventory_rows:
            raise ValueError("No tasks found for the given selection")
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

    session.commit()
    session.refresh(batch)
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


def start_batch_run_execution(batch_id: str) -> None:
    """Submit a batch to the bounded execution pool.

    When the pool is saturated the batch queues inside the executor —
    no additional worker thread is spawned (SPEC-132 Behavior 7).
    """
    future = _batch_pool().submit(_run_batch_in_background, batch_id)
    future.add_done_callback(_log_batch_pool_failure)


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
    # A check passes iff result.get("pass") is True (strict, not truthy).
    batch.total_checks = sum(len(tr.checks_json or []) for tr in task_runs)
    batch.passed_checks = sum(
        1
        for tr in task_runs
        for result in (tr.checks_json or [])
        if result.get("pass") is True
    )

    all_done = all(tr.status in ("passed", "failed", "error") for tr in task_runs)
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


def _run_batch_in_background(batch_id: str) -> None:
    try:
        with Session(engine) as session:
            batch = session.get(AgentTaskBatchRunDB, batch_id)
            if batch is None:
                logger.error("Batch %s not found in background thread", batch_id)
                return

            batch.status = "running"
            if batch.started_at is None:
                batch.started_at = datetime.now(timezone.utc)
            session.add(batch)
            session.commit()

            task_runs = session.exec(
                select(AgentTaskRunDB)
                .where(AgentTaskRunDB.batch_run_id == batch_id)
                .order_by(AgentTaskRunDB.id)
            ).all()

            for task_run in task_runs:
                _execute_task_run(session, batch, task_run)

            session.refresh(batch)
            update_batch_run_status(session, batch)
            _update_adaptive_state_if_needed(session, batch)
    except Exception:
        logger.exception("Background thread crashed for batch %s", batch_id)
        _mark_batch_as_error(batch_id)


def _mark_batch_as_error(batch_id: str) -> None:
    try:
        with Session(engine) as session:
            batch = session.get(AgentTaskBatchRunDB, batch_id)
            if batch is None:
                return

            batch.status = "error"
            batch.completed_at = datetime.now(timezone.utc)
            session.add(batch)

            stuck_runs = session.exec(
                select(AgentTaskRunDB).where(
                    AgentTaskRunDB.batch_run_id == batch_id,
                    _as_column(cast(object, AgentTaskRunDB.status)).in_(
                        ["pending", "running"]
                    ),
                )
            ).all()

            for tr in stuck_runs:
                tr.status = "error"
                tr.pass_result = False
                tr.error_message = "Background thread crashed"
                mark_failed(
                    tr, "Background thread crashed before trace could be verified"
                )
                tr.completed_at = datetime.now(timezone.utc)
                session.add(tr)

            session.commit()
            session.refresh(batch)
            _update_adaptive_state_if_needed(session, batch)
    except Exception:
        logger.exception("Failed to mark batch %s as error", batch_id)


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


def recover_stuck_runs() -> None:
    """
    Mark orphaned queued/running batches as error.

    Called on startup to clean up batches whose background threads died
    when the previous server process exited.
    """
    try:
        with Session(engine) as session:
            stuck_batches = session.exec(
                select(AgentTaskBatchRunDB).where(
                    _as_column(cast(object, AgentTaskBatchRunDB.status)).in_(
                        ["queued", "running"]
                    )
                )
            ).all()

            if not stuck_batches:
                return

            logger.warning(
                "Found %d stuck batch(es), marking as error", len(stuck_batches)
            )

            for batch in stuck_batches:
                stuck_runs = session.exec(
                    select(AgentTaskRunDB).where(
                        AgentTaskRunDB.batch_run_id == batch.id,
                        _as_column(cast(object, AgentTaskRunDB.status)).in_(
                            ["pending", "running"]
                        ),
                    )
                ).all()

                for tr in stuck_runs:
                    tr.status = "error"
                    tr.pass_result = False
                    tr.error_message = "Server restarted while run was in progress"
                    mark_failed(
                        tr, "Server restarted before trace could be verified"
                    )
                    tr.completed_at = datetime.now(timezone.utc)
                    session.add(tr)

                session.commit()
                session.refresh(batch)
                update_batch_run_status(session, batch)
    except Exception:
        logger.exception("Failed to recover stuck runs")


def _execute_task_run(
    session: Session,
    batch: AgentTaskBatchRunDB,
    task_run: AgentTaskRunDB,
) -> None:
    task_run.status = "running"
    task_run.started_at = datetime.now(timezone.utc)
    mark_pending(task_run)
    session.add(task_run)
    session.commit()

    emit_task_run_event(batch.project, task_run)

    try:
        result = _run_task_subprocess(
            task_run_id=task_run.id,
            task_dir=task_run.task_path,
            project=batch.project,
            environment=batch.environment,
            run_metadata=batch.run_metadata,
        )

        # Ingestion runs in a separate request/session while the subprocess is
        # active, so reload its atomic trace claim before validating the result.
        session.refresh(task_run)
        finalize_task_run_with_result(
            session,
            task_run,
            batch,
            adapter_name=_read_optional_str(result, "adapterName"),
            pass_result=bool(result.get("pass")),
            trace_run_id=_read_optional_str(result, "traceRunId"),
            checks=_read_list_of_dicts(result.get("checks")),
            transcript=_read_dict(result.get("transcript")),
            deliverables=_read_dict(result.get("deliverables")),
        )
    except Exception as error:
        task_run.status = "error"
        task_run.pass_result = False
        task_run.error_message = str(error)
        mark_failed(task_run, f"Task subprocess failed: {error}")

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
) -> None:
    """Write an executor's result onto a task run and roll up the batch.

    Shared between the in-process subprocess executor (``_execute_task_run``)
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
    """
    task_run.adapter_name = adapter_name
    task_run.pass_result = pass_result
    task_run.trace_run_id = reconcile_trace_id(task_run, trace_run_id)
    task_run.checks_json = checks
    task_run.transcript_json = transcript
    task_run.deliverables_json = deliverables
    trace_backend = get_trace_backend(batch.project)
    trace_backend.aggregate_costs(session, task_run, batch.project)
    trace_backend.confirm_and_link(session, task_run, batch.project)
    if errored:
        # The executor threw, not the judge — preserve the message so the
        # dashboard shows *why* the run died. This wins over the Issue #8
        # precedence below, which only applies to passed/failed verdicts.
        task_run.status = "error"
        task_run.error_message = error_message
    else:
        task_run.status = "passed" if task_run.pass_result else "failed"
        task_run.error_message = _resolve_run_error_message(
            pass_result=task_run.pass_result,
            checks=checks,
            error_message=error_message,
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
    """
    if task_run.status in ("passed", "failed", "error"):
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


def _run_task_subprocess(
    task_run_id: str,
    task_dir: str,
    project: str,
    environment: str,
    run_metadata: dict[str, object] | None,
) -> dict[str, object]:
    env = _build_task_subprocess_env(
        task_run_id=task_run_id,
        task_dir=task_dir,
        project=project,
        environment=environment,
        run_metadata=run_metadata,
    )
    workspace_dir = _detect_task_workspace_dir(task_dir)

    # SPEC-125: prefer the packaged runtime bundle; fall back to dev tsx.
    from .agent_task_runtime import resolve_task_runtime

    resolved = resolve_task_runtime()
    if not resolved.available:
        # Surface an operator-grade error rather than ENOENT or a stack trace.
        raise RuntimeError(
            resolved.error
            or "Agent task runtime is not installed in this deployment"
        )

    # SPEC-125: hydrate task-workspace dependencies before execution so
    # real synced Git sources can run without manual setup. Cached by
    # lockfile hash; falls through silently when no lockfile is present.
    from .task_dependency_installer import (
        TaskDependencyInstallError,
        install_task_dependencies,
    )

    try:
        install_task_dependencies(workspace_dir)
    except TaskDependencyInstallError as error:
        # Propagate as a normal task-run error; do NOT crash the batch.
        raise RuntimeError(str(error)) from error

    try:
        completed = subprocess.run(
            resolved.runner_argv,
            cwd=str(workspace_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=TASK_SUBPROCESS_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as error:
        raise RuntimeError(
            "Agent task runtime is not installed in this deployment"
        ) from error

    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        details = (
            stderr or stdout or f"Node process exited with code {completed.returncode}"
        )
        raise RuntimeError(details)

    stdout = completed.stdout.strip()
    if not stdout:
        raise RuntimeError("Task subprocess produced no output")

    try:
        parsed_raw = cast(object, json.loads(stdout))
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"Failed to parse task subprocess output: {error}"
        ) from error

    if not isinstance(parsed_raw, dict):
        raise RuntimeError("Task subprocess output was not a JSON object")

    return cast(dict[str, object], parsed_raw)


# Platform secrets that must NEVER reach task code, regardless of the
# operator allow-list. Task code is trusted code the operator authorized,
# but platform credentials (auth signing, database, SMTP, OAuth) are not
# credentials the operator granted to task code. (SPEC-132 Behavior 6.)
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


def _build_task_subprocess_env(
    *,
    task_run_id: str,
    task_dir: str,
    project: str,
    environment: str,
    run_metadata: dict[str, object] | None,
) -> dict[str, str]:
    """Build the minimal, allow-listed environment for a task subprocess.

    Task subprocesses receive ONLY: process essentials (PATH, HOME, ...),
    the task contract (AGENT_TASK_*, APO_AUTH_TOKEN, provider keys), and
    any extra names the operator listed in ``APO_TASK_ENV_ALLOWLIST``.
    Platform secrets on the deny-list are excluded unconditionally.

    (SPEC-132 Behavior 6: Task Code Receives Only Task Credentials.)
    """
    env: dict[str, str] = {}

    # 1. Process essentials (so Node/Python can run).
    for name in _TASK_ENV_PROCESS_ESSENTIALS:
        value = os.environ.get(name)
        if value:
            env[name] = value

    # 2. Operator allow-list extras (deny-listed names refused even here).
    allowlist_raw = os.environ.get("APO_TASK_ENV_ALLOWLIST", "")
    for name in _parse_env_allowlist(allowlist_raw):
        if name in _TASK_ENV_DENY_LIST:
            continue
        value = os.environ.get(name)
        if value:
            env[name] = value

    # 3. Provider/model credentials the runtime needs.
    for name in _TASK_ENV_PROVIDER_VARS:
        value = os.environ.get(name)
        if value:
            env[name] = value

    # 4. The task contract itself.
    env["AGENT_TASK_DIR"] = task_dir
    env["AGENT_TASK_PROJECT"] = project
    env["AGENT_TASK_ENVIRONMENT"] = environment
    env["AGENT_TASK_TRACE_ENDPOINT"] = (
        os.environ.get("APO_BACKEND_URL") or "http://127.0.0.1:8000"
    )
    env["AGENT_TASK_RUN_ID"] = task_run_id
    env["AGENT_TASK_TRACE_REQUIRED"] = "true"
    env["APO_AUTH_TOKEN"] = create_agent_task_trace_token(
        task_run_id=task_run_id,
        project=project,
    )
    env["OPENROUTER_BASE_URL"] = os.environ.get(
        "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
    )
    env["OPENROUTER_MODEL"] = os.environ.get(
        "AGENT_TASK_OPENROUTER_MODEL", "google/gemini-2.5-flash-lite"
    )

    normalized_run_metadata = {
        "agent_task_run_id": task_run_id,
        **(run_metadata or {}),
    }
    env["AGENT_TASK_RUN_METADATA"] = json.dumps(normalized_run_metadata)
    return env


def _parse_env_allowlist(raw: str) -> tuple[str, ...]:
    """Parse ``APO_TASK_ENV_ALLOWLIST`` into a deduped tuple of names.

    Comma-separated, whitespace-tolerant, empty entries dropped.
    """
    seen: list[str] = []
    for token in raw.split(","):
        name = token.strip()
        if name and name not in seen:
            seen.append(name)
    return tuple(seen)


def _detect_task_workspace_dir(task_dir: str) -> Path:
    """Best-effort workspace root for executing a task.

    Resolution order:

    1. **Monorepo workspace root** — the nearest ancestor with a
       ``pnpm-workspace.yaml``. Running from here (rather than a nested
       ``package.json``) is what lets ``@apo/sdk`` resolve correctly under
       ``tsx``: a leaf ``package.json`` with ``"type": "module"`` (e.g. the
       bundled ``agent-task-demo``) confuses tsx's ``exports`` resolution
       so ``@apo/sdk/agent-task`` falls back to a directory ``index.ts``
       whose ``export *`` re-export chain doesn't surface named exports,
       producing "does not provide an export named 'defineAdapter'". The
       monorepo root has no such ESM-scope problem.
    2. The nearest ancestor that looks like an application/package root
       (``package.json``, ``pyproject.toml``, lockfiles).
    3. The nearest workspace marker (``yarn.lock``, ``package-lock.json``,
       ``.git``).
    4. The task directory itself.

    External Git sources are unaffected by step 1 — they have no
    ``pnpm-workspace.yaml``, so they fall through to the package-root
    logic unchanged.
    """
    current = Path(task_dir).resolve()

    monorepo_root = _nearest_ancestor_with_marker(current, {"pnpm-workspace.yaml"})
    if monorepo_root is not None:
        return monorepo_root

    package_markers = {
        "package.json",
        "pyproject.toml",
        "requirements.txt",
        "uv.lock",
        "poetry.lock",
    }
    nearest_package_root = _nearest_ancestor_with_marker(current, package_markers)
    if nearest_package_root is not None:
        return nearest_package_root

    workspace_markers = {"yarn.lock", "package-lock.json", ".git"}
    nearest_workspace = _nearest_ancestor_with_marker(current, workspace_markers)
    if nearest_workspace is not None:
        return nearest_workspace

    return current


def _nearest_ancestor_with_marker(start: Path, markers: set[str]) -> Path | None:
    """Walk up from ``start``; return the first dir containing any marker."""
    probe = start
    while True:
        if any((probe / marker).exists() for marker in markers):
            return probe
        if probe.parent == probe:
            return None
        probe = probe.parent


def _read_dict(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    return cast(dict[str, object], value)


def _read_list_of_dicts(value: object) -> list[dict[str, object]] | None:
    if not isinstance(value, list):
        return None
    normalized: list[dict[str, object]] = []
    for item in cast(list[object], value):
        if isinstance(item, dict):
            normalized.append(cast(dict[str, object], item))
    return normalized


def _read_optional_str(data: dict[str, object], key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) else None
