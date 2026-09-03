# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedImport=false

"""Execution Attempt finalization (result / failure).

Owns the bounded result body, completion idempotency, exit code, and bounded
diagnostic tails. Delegates Task Run verdict/Checks/Deliverables/cost/Trace to
the shared :mod:`agent_task_run_service` finalizer so the new protocol and the
old subprocess path land terminal state identically.

Completion idempotency (§Start, heartbeat, result, failure): a result is
idempotent by ``(completion_id, canonical body digest)``. A replay with the
same ID and body is a no-op success; a replay with the same ID but a different
body raises a ``CompletionConflict`` (mapped to 409 by the route).
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from sqlmodel import Session, select

from apo.db_helpers import as_column
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, TaskExecutionAttemptDB
from apo.models.schemas import AgentTaskRunConfiguration
from apo.services.agent_task_runner import finalize_task_run_with_result, update_batch_run_status
from apo.services.execution_leases import (
    CANCELLED,
    FAILED,
    SUCCEEDED,
    CurrentAttemptLease,
    LeaseError,
    _require_current,
)

# Bounded diagnostic tails: 64 KiB each.
DIAGNOSTIC_TAIL_BYTES = 64 * 1024

_VALID_FAILURE_KINDS = frozenset(
    {
        "dependency_install",
        "bundle_invalid",
        "task_import",
        "task_runtime",
        "result_invalid",
        "timeout",
        "oom",
        "driver",
        "lease_expired",
        "executor_unavailable",
        "executor_shutdown",
        "cancelled",
        "internal",
    }
)


class CompletionConflict(Exception):
    """Same completion_id replayed with a different body (route maps to 409)."""


class FinalizationError(Exception):
    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"[{kind}] {message}")
        self.kind = kind


@dataclass(frozen=True)
class AttemptResultBody:
    """Bounded result payload reported by an Executor."""

    completion_id: str
    pass_result: bool
    adapter_name: str | None = None
    trace_run_id: str | None = None
    checks: list[dict[str, object]] | None = None
    transcript: dict[str, object] | None = None
    deliverables: dict[str, object] | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None
    error_message: str | None = None
    # adapter-reported model/effort.
    run_configuration: AgentTaskRunConfiguration | None = None


@dataclass(frozen=True)
class AttemptFailureBody:
    completion_id: str
    failure_kind: str
    error_message: str | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None


def _tail(text: str | None) -> str | None:
    if text is None:
        return None
    return text[-DIAGNOSTIC_TAIL_BYTES:]


def _body_digest(payload: object) -> str:
    import json

    return hashlib.sha256(
        json.dumps(
            payload,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            # the result body can carry an ``AgentTaskRunConfiguration``
            # (an SQLModel). json can't serialize it directly, so fall back to its
            # dict form — this digest is only for completion-id idempotency.
            default=lambda o: o.model_dump() if hasattr(o, "model_dump") else str(o),
        ).encode()
    ).hexdigest()


def _check_completion_idempotency(
    session: Session,
    *,
    attempt: TaskExecutionAttemptDB,
    completion_id: str,
    digest: str,
    terminal_status: str,
) -> bool:
    """Return True if this completion is an idempotent replay (already done)."""
    existing = session.exec(
        select(TaskExecutionAttemptDB).where(
            as_column(TaskExecutionAttemptDB.completion_id) == completion_id,
            as_column(TaskExecutionAttemptDB.id) != attempt.id,
        )
    ).first()
    if existing is not None:
        raise CompletionConflict("completion_id already used by another attempt")
    if attempt.completion_id == completion_id and attempt.status == terminal_status:
        if attempt.completion_sha256 == digest:
            return True  # idempotent replay
        raise CompletionConflict("completion_id replayed with a different body")
    if attempt.completion_id is not None and attempt.completion_id != completion_id:
        raise CompletionConflict("attempt already finalized with a different completion_id")
    return False


def finalize_attempt_result(
    session: Session,
    *,
    lease: CurrentAttemptLease,
    body: AttemptResultBody,
) -> TaskExecutionAttemptDB:
    """Apply a bounded result: attempt succeeded, Task Run finalized via the
    shared finalizer, batch rolled up. Idempotent by (completion_id, digest)."""
    attempt = _require_current(session, lease)
    digest = _body_digest({"kind": "result", "body": asdict(body)})
    if _check_completion_idempotency(
        session,
        attempt=attempt,
        completion_id=body.completion_id,
        digest=digest,
        terminal_status=SUCCEEDED,
    ):
        return attempt
    if attempt.status != "running":
        raise LeaseError("state_mismatch", f"cannot finalize result from status {attempt.status!r}")

    now = datetime.now(timezone.utc)
    attempt.status = SUCCEEDED
    attempt.completion_id = body.completion_id
    attempt.completion_sha256 = digest
    attempt.exit_code = body.exit_code
    attempt.stdout_tail = _tail(body.stdout_tail)
    attempt.stderr_tail = _tail(body.stderr_tail)
    attempt.completed_at = now
    session.add(attempt)

    _finalize_task_run(
        session, attempt,
        pass_result=body.pass_result, adapter_name=body.adapter_name,
        trace_run_id=body.trace_run_id, checks=body.checks,
        transcript=body.transcript, deliverables=body.deliverables,
        error_message=body.error_message, errored=False,
        run_configuration=body.run_configuration,
    )
    session.commit()
    session.refresh(attempt)
    _emit_finalization_events(session, attempt)
    return attempt


def finalize_attempt_failure(
    session: Session,
    *,
    lease: CurrentAttemptLease,
    body: AttemptFailureBody,
) -> TaskExecutionAttemptDB:
    """Apply an operational failure: attempt failed, Task Run errored."""
    if body.failure_kind not in _VALID_FAILURE_KINDS:
        raise FinalizationError("bad_failure_kind", f"unknown failure kind {body.failure_kind!r}")
    attempt = _require_current(session, lease)
    terminal_status = CANCELLED if body.failure_kind == "cancelled" else FAILED
    digest = _body_digest({"kind": "failure", "body": asdict(body)})
    if _check_completion_idempotency(
        session,
        attempt=attempt,
        completion_id=body.completion_id,
        digest=digest,
        terminal_status=terminal_status,
    ):
        return attempt
    if attempt.status not in ("leased", "running"):
        raise LeaseError("state_mismatch", f"cannot finalize failure from status {attempt.status!r}")

    now = datetime.now(timezone.utc)
    attempt.status = terminal_status
    attempt.completion_id = body.completion_id
    attempt.completion_sha256 = digest
    attempt.failure_kind = body.failure_kind
    attempt.error_message = body.error_message
    attempt.exit_code = body.exit_code
    attempt.stdout_tail = _tail(body.stdout_tail)
    attempt.stderr_tail = _tail(body.stderr_tail)
    attempt.completed_at = now
    session.add(attempt)
    if terminal_status == CANCELLED:
        batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
        if batch is None:
            raise FinalizationError("not_found", "batch run not found")
        batch.cancelled_tasks += 1
        session.add(batch)

    _finalize_task_run(
        session, attempt, pass_result=False, adapter_name=None, trace_run_id=None,
        checks=None, transcript=None, deliverables=None,
        error_message=body.error_message or body.failure_kind, errored=True,
    )
    session.commit()
    session.refresh(attempt)
    _emit_finalization_events(session, attempt)
    return attempt


def _finalize_task_run(
    session: Session,
    attempt: TaskExecutionAttemptDB,
    *,
    pass_result: bool,
    adapter_name: str | None,
    trace_run_id: str | None,
    checks: list[dict[str, object]] | None,
    transcript: dict[str, object] | None,
    deliverables: dict[str, object] | None,
    error_message: str | None,
    errored: bool,
    run_configuration: AgentTaskRunConfiguration | None = None,
) -> None:
    task_run = session.get(AgentTaskRunDB, attempt.task_run_id)
    if task_run is None:
        raise FinalizationError("not_found", "task run not found")
    batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
    if batch is None:
        raise FinalizationError("not_found", "batch run not found")
    finalize_task_run_with_result(
        session, task_run, batch,
        adapter_name=adapter_name, pass_result=pass_result, trace_run_id=trace_run_id,
        checks=checks, transcript=transcript, deliverables=deliverables,
        errored=errored, error_message=error_message,
        run_configuration=run_configuration,
    )
    task_run.completed_at = datetime.now(timezone.utc)
    session.add(task_run)
    update_batch_run_status(session, batch)
    # when the Batch just became terminal, resolve its pending
    # Schedule Occurrence (delivered vs missed) and clear the active pointer.
    from apo.services.schedule_occurrences import resolve_occurrence_if_terminal
    resolve_occurrence_if_terminal(session, batch)


def _emit_finalization_events(
    session: Session,
    attempt: TaskExecutionAttemptDB,
) -> None:
    """Publish the same lifecycle events as the former subprocess path."""
    from apo.services.run_events import emit_batch_run_event, emit_task_run_event

    task_run = session.get(AgentTaskRunDB, attempt.task_run_id)
    batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
    if task_run is None or batch is None:
        return
    emit_task_run_event(attempt.project, task_run)
    if batch.status in ("completed", "error"):
        task_runs = list(
            session.exec(
                select(AgentTaskRunDB).where(
                    as_column(AgentTaskRunDB.batch_run_id) == batch.id
                )
            ).all()
        )
        emit_batch_run_event(attempt.project, batch, task_runs)


def precheck_result_replay(
    session: Session,
    *,
    lease: CurrentAttemptLease,
    body: AttemptResultBody,
) -> bool:
    """Check completion idempotency before deliverable persistence.

    Returns True if this is an idempotent replay — the caller should return
    early without persisting deliverables.
    Raises CompletionConflict for conflicting replays.
    Returns False for first finalization — proceed to persist + finalize.
    """
    attempt = _require_current(session, lease)
    digest = _body_digest({"kind": "result", "body": asdict(body)})
    return _check_completion_idempotency(
        session,
        attempt=attempt,
        completion_id=body.completion_id,
        digest=digest,
        terminal_status=SUCCEEDED,
    )


async def finalize_attempt_with_deliverables(
    session: Session,
    *,
    lease: CurrentAttemptLease,
    body: AttemptResultBody,
    deliverables: dict[str, object] | None,
) -> TaskExecutionAttemptDB | None:
    """Precheck replay, persist JSON deliverables, then finalize the attempt.

    Shared by executor protocol v1 and v2 result routes so the
    precheck → persist → finalize ordering lives in one place.

    Returns the finalized attempt, or ``None`` for an idempotent replay
    (caller should return its replay response without touching the result).
    Raises ``CompletionConflict`` / ``ValueError`` / ``LeaseError`` — the
    caller maps these to HTTP responses.
    """
    # Issue #174: the body digest and the finalization SQL are seconds of sync
    # work over multi-MB result bodies. Run them off the event loop so one
    # heavy finalize cannot freeze heartbeats and every other request behind
    # it. The request session is safe to hand over: SQLite opens with
    # check_same_thread=False and each call is fully awaited before the
    # session is touched again.
    if await asyncio.to_thread(precheck_result_replay, session, lease=lease, body=body):
        return None

    if deliverables:
        from apo.models.db import TaskExecutionAttemptDB
        from apo.services.agent_task_deliverables import persist_json_deliverable
        from apo.services.artifact_stores.registry import get_store

        attempt_row = session.get(TaskExecutionAttemptDB, lease.attempt_id)
        if attempt_row is not None:
            store = get_store(None)
            for name, value in deliverables.items():
                await persist_json_deliverable(
                    session,
                    project=attempt_row.project,
                    task_run_id=attempt_row.task_run_id,
                    name=name,
                    value=value,
                    store=store,
                )
            session.flush()

    return await asyncio.to_thread(finalize_attempt_result, session, lease=lease, body=body)


__all__ = [
    "AttemptFailureBody",
    "AttemptResultBody",
    "CompletionConflict",
    "DIAGNOSTIC_TAIL_BYTES",
    "FinalizationError",
    "finalize_attempt_failure",
    "finalize_attempt_result",
    "finalize_attempt_with_deliverables",
    "precheck_result_replay",
]
