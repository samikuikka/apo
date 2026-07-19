# pyright: reportUnusedParameter=false
"""Trace backend abstraction.

Defines the contract for *where task-run traces live* and *how the task
runner reads them back at completion*. The agent task runner never talks to
trace storage directly — it goes through :func:`get_trace_backend`, which
returns a :class:`TraceBackend`.

Today only :class:`NativeTraceBackend` exists: it reads from Apo's own
``runs``/``logged_calls`` tables. The interface is the slot a future
external backend (e.g. one that fetches traces from a user's Langfuse
instance at completion and stores them locally) plugs into, without the
task runner or the trace UI needing to know which backend is active.
"""

from __future__ import annotations

from typing import Protocol

from sqlmodel import Session, select

from ..models.db import AgentTaskRunDB, LoggedCallDB, RunDB
from .trace_ownership import mark_failed, mark_persisted


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------


class TraceBackend(Protocol):
    """Where a task run's trace lives and how its completion data is read.

    Implementations own the trace-storage side effects (confirming a trace is
    present, linking it back to the task run, backfilling trace-level I/O) and
    the cost/token roll-up. They mutate ``task_run`` bookkeeping fields in
    place: ``trace_persistence_status``/``trace_error_message`` for
    :meth:`confirm_and_link` and ``total_cost``/``total_tokens`` for
    :meth:`aggregate_costs`.
    """

    def confirm_and_link(
        self, session: Session, task_run: AgentTaskRunDB, project: str
    ) -> None:
        """Confirm the trace for ``task_run.trace_run_id`` is available, link it
        back to the task run, and backfill trace-level input/output.

        ``project`` scopes the trace lookup so two task runs in different
        Projects cannot claim each other's trace if they happen to share an
        OTel id (SPEC-133 M4).

        Sets ``task_run.trace_persistence_status`` to ``"persisted"`` on
        success or ``"failed"`` (with ``trace_error_message``) otherwise.
        """
        ...

    def aggregate_costs(
        self, session: Session, task_run: AgentTaskRunDB, project: str
    ) -> None:
        """Sum token usage and cost across every observation in the trace.

        ``project`` scopes the observation set so a cross-project trace id
        collision cannot inflate another run's totals (SPEC-133 M4).

        Sets ``task_run.total_cost`` / ``task_run.total_tokens``. No-op when
        the task run has no trace.
        """
        ...


# ---------------------------------------------------------------------------
# Native implementation (Apo's own runs/logged_calls tables)
# ---------------------------------------------------------------------------


class NativeTraceBackend:
    """Reads task-run traces from Apo's local ``runs``/``logged_calls`` tables.

    This is the zero-config default: the SDK ingests into Apo directly, so the
    trace is already in the database by the time the task completes.
    """

    def confirm_and_link(
        self, session: Session, task_run: AgentTaskRunDB, project: str
    ) -> None:
        if not task_run.trace_run_id:
            mark_failed(task_run, "Task subprocess did not return a trace run id")
            return

        persisted_run = session.exec(
            select(RunDB).where(
                RunDB.id == task_run.trace_run_id, RunDB.project == project
            )
        ).first()
        if persisted_run is None:
            mark_failed(
                task_run,
                f"Trace run '{task_run.trace_run_id}' was not persisted to the runs table",
            )
            return

        mark_persisted(task_run)
        # Link the task run's single trace for reverse lookup.
        persisted_run.task_run_id = task_run.id
        # Langfuse-style trace-level I/O: input = first user message, output = deliverables.
        persisted_run.input = _extract_task_input(task_run.transcript_json)
        persisted_run.output = task_run.deliverables_json
        session.add(persisted_run)

    def aggregate_costs(
        self, session: Session, task_run: AgentTaskRunDB, project: str
    ) -> None:
        if not task_run.trace_run_id:
            return
        calls = session.exec(
            select(LoggedCallDB).where(
                LoggedCallDB.run_id == task_run.trace_run_id,
                LoggedCallDB.project == project,
            )
        ).all()
        total_cost = 0.0
        total_tokens = 0
        for call in calls:
            # SPEC-136: ``cost`` is the single effective total (micro-USD int);
            # fall back to ``provided_cost`` only when cost is unset.
            effective = call.cost if call.cost is not None else call.provided_cost
            if effective is not None:
                total_cost += effective
            if call.total_tokens is not None:
                total_tokens += call.total_tokens
        has_any_cost = any(
            call.cost is not None or call.provided_cost is not None for call in calls
        )
        task_run.total_cost = round(total_cost, 6) if has_any_cost else None
        task_run.total_tokens = total_tokens if total_tokens > 0 else None


def _extract_task_input(transcript: object) -> str | None:
    """Pull the first user message from a task transcript as the trace input."""
    if not isinstance(transcript, dict):
        return None
    turns = transcript.get("turns")
    if not isinstance(turns, list) or not turns:
        return None
    first = turns[0]
    if not isinstance(first, dict):
        return None
    action = first.get("userAction")
    if isinstance(action, dict):
        content = action.get("content")
        if isinstance(content, str):
            return content
    return None


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

_NATIVE = NativeTraceBackend()


def get_trace_backend(project: str | None = None) -> TraceBackend:
    """Return the active trace backend for a project.

    Currently only the native backend exists. A future external backend
    (e.g. a per-project Langfuse connector) is selected here — the task runner
    and trace UI never branch on the source themselves.
    """
    return _NATIVE
