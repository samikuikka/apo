"""Task-run trace ownership: the one-trace-per-run invariant and its lifecycle.

Single source of truth for the trace persistence state machine. A task run
owns at most one trace, claimed atomically at ingestion time and moved
through ``pending -> persisted | failed`` as the subprocess completes.

The status constants live here so the literal strings ``"pending"`` /
``"persisted"`` / ``"failed"`` appear in exactly one place, and every
transition goes through a helper that sets status and error message
together (the two must never drift apart).
"""

from __future__ import annotations

from collections.abc import Sequence
import logging

from sqlmodel import Session, col, update

from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from ..models.trace_ingestion import TraceIngestionContext

logger = logging.getLogger(__name__)

TRACE_PENDING = "pending"
TRACE_PERSISTED = "persisted"
TRACE_FAILED = "failed"


# ---------------------------------------------------------------------------
# Task-run transitions
# ---------------------------------------------------------------------------


def mark_pending(run: AgentTaskRunDB) -> None:
    """Reset a task run's trace lifecycle to pending (clears any prior error)."""
    run.trace_persistence_status = TRACE_PENDING
    run.trace_error_message = None


def mark_persisted(run: AgentTaskRunDB) -> None:
    """Mark a task run's trace as successfully persisted."""
    run.trace_persistence_status = TRACE_PERSISTED
    run.trace_error_message = None


def mark_failed(run: AgentTaskRunDB, error_message: str) -> None:
    """Mark a task run's trace persistence as failed with a reason."""
    run.trace_persistence_status = TRACE_FAILED
    run.trace_error_message = error_message


# ---------------------------------------------------------------------------
# Batch roll-up
# ---------------------------------------------------------------------------


def roll_up_batch(
    batch: AgentTaskBatchRunDB, task_runs: Sequence[AgentTaskRunDB]
) -> None:
    """Derive a batch's trace status from its task runs (worst-case wins).

    Any failed task run marks the batch failed; otherwise only fully
    persisted batches are marked persisted. Mixed/in-flight batches fall
    back to pending so callers never see a false "persisted" signal.
    No-op when there are no task runs.
    """
    if not task_runs:
        return

    statuses = [tr.trace_persistence_status for tr in task_runs]
    failed_count = sum(1 for status in statuses if status == TRACE_FAILED)
    if failed_count > 0:
        batch.trace_persistence_status = TRACE_FAILED
        batch.trace_error_message = (
            f"{failed_count} of {len(task_runs)} task run(s) failed trace persistence"
        )
        return

    if all(status == TRACE_PERSISTED for status in statuses):
        batch.trace_persistence_status = TRACE_PERSISTED
        batch.trace_error_message = None
        return

    batch.trace_persistence_status = TRACE_PENDING
    batch.trace_error_message = None


# ---------------------------------------------------------------------------
# Claim + reconcile (the one-trace-per-run invariant)
# ---------------------------------------------------------------------------


def claim_trace(session: Session, task_run_id: str, trace_id: str) -> None:
    """Atomically reserve the task run's single trace id before ingestion.

    Raises ``ValueError`` if the task run does not exist or already owns a
    different trace. Owns its commit (used by the legacy ingestion route).
    """
    claim_trace_in_session(session, task_run_id, trace_id)
    session.commit()


def claim_trace_in_session(session: Session, task_run_id: str, trace_id: str) -> None:
    """The atomic claim, without committing the outer transaction.

    Does the conditional ``UPDATE ... WHERE trace_run_id IS NULL``, flushes so
    the row is visible within the current transaction, then validates the
    one-trace invariant. The caller owns the commit boundary (SPEC-131 M4.4).
    Raises ``ValueError`` if the task run does not exist or already owns a
    different trace.
    """
    _ = session.exec(
        update(AgentTaskRunDB)
        .where(
            col(AgentTaskRunDB.id) == task_run_id,
            col(AgentTaskRunDB.trace_run_id).is_(None),
        )
        .values(trace_run_id=trace_id)
    )
    session.flush()
    session.expire_all()
    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise ValueError(f"Task run '{task_run_id}' does not exist")
    if task_run.trace_run_id != trace_id:
        raise ValueError(
            f"Task run '{task_run_id}' already owns trace '{task_run.trace_run_id}'; a second trace is not allowed"
        )


def authorize_and_claim_trace(
    session: Session,
    *,
    context: TraceIngestionContext | None,
    task_run_id: str,
    trace_id: str,
) -> bool:
    """Verify an ingestion claim and reserve the Task Run in this transaction.

    Telemetry attributes are never sufficient authorization. Only a service
    token whose subject matches ``task_run_id`` and whose Project owns the Task
    Run may reserve the trace. Invalid claim attributes remain ordinary
    telemetry and return ``False`` without mutating ownership.
    """
    if context is None or not context.may_claim_task_run:
        logger.warning(
            "Rejecting task-run claim for trace %s: no authenticated service token subject",
            trace_id,
        )
        return False
    if task_run_id != context.service_task_run_id:
        logger.warning(
            "Rejecting task-run claim: payload task run %s does not match token subject %s",
            task_run_id,
            context.service_task_run_id,
        )
        return False

    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        logger.warning("Task run %s does not exist; cannot claim", task_run_id)
        return False
    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is None or batch.project != context.project_id:
        logger.warning(
            "Rejecting task-run claim %s: authenticated Project does not own it",
            task_run_id,
        )
        return False

    if task_run.trace_run_id == trace_id:
        return True
    try:
        claim_trace_in_session(session, task_run_id, trace_id)
    except ValueError as exc:
        logger.warning("Task-run claim rejected: %s", exc)
        return False
    return True


def reconcile_trace_id(
    task_run: AgentTaskRunDB, returned_trace_id: str | None
) -> str | None:
    """Keep the ingestion-time trace claim consistent with subprocess output.

    Raises ``RuntimeError`` if the subprocess returned a different trace id
    than the one claimed at ingestion.
    """
    if (
        task_run.trace_run_id is not None
        and task_run.trace_run_id != returned_trace_id
    ):
        returned = f"Task subprocess returned trace '{returned_trace_id}'"
        ownership = (
            f"task run '{task_run.id}' already owns trace '{task_run.trace_run_id}'"
        )
        raise RuntimeError(f"{returned}, but {ownership}")
    return returned_trace_id
