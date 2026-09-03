# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedParameter=false
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

from collections.abc import Sequence
from typing import Protocol

from sqlmodel import Session, select

from ..models.db import AgentTaskRunDB, LoggedCallDB, OtlpSpanDB, RunDB
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
        OTel id.

        Sets ``task_run.trace_persistence_status`` to ``"persisted"`` on
        success or ``"failed"`` (with ``trace_error_message``) otherwise.
        """
        ...

    def aggregate_costs(
        self, session: Session, task_run: AgentTaskRunDB, project: str
    ) -> None:
        """Sum token usage and cost across every observation in the trace.

        ``project`` scopes the observation set so a cross-project trace id
        collision cannot inflate another run's totals.

        Sets ``task_run.total_cost`` / ``task_run.total_tokens`` and the
        bounded Generation Execution Summary. Errored generations are excluded
        from usage totals, which consumers must present as partial. No-op when
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
        # trace-level output carries a compact
        # Deliverable manifest (name/kind/size only), never a body.
        persisted_run.output = _trace_output_for_task_run(task_run)
        # trace-level input comes from the canonical trace projection
        # (Generation Observation inputs), not the redundant task transcript.
        # New rows leave ``transcript_json`` null; legacy rows are not rewritten
        # here, so we only derive input when a legacy transcript is present.
        persisted_run.input = _extract_task_input(task_run.transcript_json)
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
        spans = session.exec(
            select(OtlpSpanDB).where(
                OtlpSpanDB.trace_id == task_run.trace_run_id,
                OtlpSpanDB.project_id == project,
            )
        ).all()
        generation_execution, errored_span_ids = _generation_execution(calls, spans)
        task_run.generation_execution_json = generation_execution
        total_cost = 0.0
        total_tokens = 0
        unpriced_count = 0
        for call in calls:
            # A provider error often omits the final streamed usage event and
            # therefore projects as a plausible zero. Exclude the observation
            # instead of treating that zero as a complete measurement.
            if call.id in errored_span_ids:
                continue
            # ``cost`` is the single effective total (micro-USD int);
            # fall back to ``provided_cost`` only when cost is unset.
            effective = call.cost if call.cost is not None else call.provided_cost
            if effective is not None:
                total_cost += effective
            if call.total_tokens is not None:
                total_tokens += call.total_tokens
            # Issue #94: carry unpriced provenance up so the total is not
            # presented as complete when a model had no pricing pattern.
            if call.cost_provenance == "unpriced":
                unpriced_count += 1
        has_any_cost = any(
            call.id not in errored_span_ids
            and (call.cost is not None or call.provided_cost is not None)
            for call in calls
        )
        task_run.total_cost = round(total_cost, 6) if has_any_cost else None
        task_run.total_tokens = total_tokens if total_tokens > 0 else None
        task_run.unpriced_call_count = unpriced_count


def _generation_execution(
    calls: Sequence[LoggedCallDB], spans: Sequence[OtlpSpanDB]
) -> tuple[dict[str, object] | None, set[str]]:
    """Summarize canonical Generation Observations and identify error rows.

    Projection rows provide APO's normalized observation type; canonical spans
    provide the lossless OTel status and finish reasons. Calls without a
    canonical span are legacy/unknown and are intentionally not reported as
    healthy.
    """
    span_by_id = {span.span_id: span for span in spans}
    generation_spans = [
        span_by_id[call.id]
        for call in calls
        if call.observation_type == "GENERATION" and call.id in span_by_id
    ]
    if not generation_spans:
        return None, set()

    errored_span_ids: set[str] = set()
    reason_counts: dict[str, int] = {}
    for span in generation_spans:
        finish_reasons = _finish_reasons(span.attributes or {})
        error_finish_reasons = [
            reason for reason in finish_reasons if reason in _ERROR_FINISH_REASONS
        ]
        if span.status_code != 2 and not error_finish_reasons:
            continue
        errored_span_ids.add(span.span_id)
        reasons = error_finish_reasons or ["otel_error"]
        for reason in reasons:
            reason_counts[reason] = reason_counts.get(reason, 0) + 1

    return (
        {
            "total": len(generation_spans),
            "errored": len(errored_span_ids),
            "error_finish_reasons": reason_counts,
        },
        errored_span_ids,
    )


def _finish_reasons(attributes: dict[str, object]) -> list[str]:
    """Read standard and common vendor finish-reason attribute shapes."""
    for key in _FINISH_REASON_KEYS:
        value = attributes.get(key)
        if isinstance(value, str):
            return [_normalize_finish_reason(value)] if value else []
        if isinstance(value, list):
            return [
                normalized
                for item in value
                if isinstance(item, str)
                and (normalized := _normalize_finish_reason(item))
            ]
    return []


def _normalize_finish_reason(value: str) -> str:
    return value.strip().lower().replace("-", "_").replace(" ", "_")


_FINISH_REASON_KEYS = (
    "gen_ai.response.finish_reasons",
    "gen_ai.response.finish_reason",
    "ai.response.finishReason",
)
_ERROR_FINISH_REASONS = frozenset({"error", "errored", "failed", "failure"})


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


def _trace_output_for_task_run(task_run: AgentTaskRunDB) -> dict[str, object] | None:
    """Build the compact Deliverable manifest written to ``RunDB.output``.

    The trace row carries name/kind/size only, never a body. Runs with no
    Deliverable rows leave output null. (The legacy ``deliverables_json``
    synthesis was removed with the column in schema v28.)
    """
    # New rows: Deliverable rows are written by the service before
    # confirm_and_link runs in finalize_task_run_with_result, but confirm_and_link
    # is also called independently; query them lazily through the session bound
    # to the task_run when available. ``object_session`` returns the SQLAlchemy
    # base type statically; at runtime it is the sqlmodel Session that loaded
    # the row, so cast for the service's stricter annotation.
    from typing import cast

    from sqlmodel import Session as SqlModelSession

    raw_session = Session.object_session(task_run)
    if raw_session is None:
        return None
    from .agent_task_deliverables import (
    build_deliverable_manifest,
    build_trace_output_manifest,
)

    items = build_deliverable_manifest(cast(SqlModelSession, raw_session), task_run.id)
    if not items:
        return None
    return build_trace_output_manifest(items, task_run.id)


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
