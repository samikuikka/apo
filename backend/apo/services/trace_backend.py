# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedParameter=false
"""Trace backend abstraction.

Defines the contract for *where task-run traces live* and *how the task
runner reads them back at completion*. The agent task runner never talks to
trace storage directly — it goes through :func:`get_trace_backend`, which
returns a :class:`TraceBackend`.

Today only :class:`NativeTraceBackend` exists: it reads from Apo's own
``runs``/``logged_calls`` tables. The interface is the slot a future
external backend (e.g. one that fetches traces from an external source
at completion and stores them locally) plugs into, without the
task runner or the trace UI needing to know which backend is active.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from sqlmodel import Session, select

from ..models.db import AgentTaskRunDB, LoggedCallDB, OtlpSpanDB, RunDB
from .trace_ownership import mark_failed, mark_persisted


# ---------------------------------------------------------------------------
# Reasoning / timing rollups (issue #309)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GenerationRollups:
    """The issue #309 per-run rollups, computed and applied as one unit."""

    total_reasoning_tokens: int | None = None
    max_call_reasoning_tokens: int | None = None
    max_call_reasoning_call_id: str | None = None
    max_call_latency_ms: float | None = None
    max_call_latency_call_id: str | None = None
    total_model_time_ms: float | None = None


def compute_generation_rollups(
    calls: Sequence[LoggedCallDB], errored_span_ids: set[str]
) -> GenerationRollups:
    """Derive the reasoning/timing rollups from a run's observations.

    Model-call facts: only ``GENERATION`` observations count. Tool and
    structural rows carry latencies too (the agent-task root span's latency
    is the run's whole wall clock), and counting those would double-count
    the run and let a tool win "slowest call". Usage reasoning additionally
    skips errored generations (a provider error omits the final usage
    event, so its projected usage is not a measurement); latency keeps
    them — a generation that failed after four minutes still spent four
    minutes in the model. All-unreported reasoning stays ``None``
    (unknown, not zero).
    """
    total_reasoning: int | None = None
    max_reasoning: int | None = None
    max_reasoning_call_id: str | None = None
    max_latency_ms: float | None = None
    max_latency_call_id: str | None = None
    model_time_ms = 0.0
    saw_latency = False
    for call in calls:
        if call.observation_type != "GENERATION":
            continue
        if call.latency_ms is not None:
            saw_latency = True
            model_time_ms += call.latency_ms
            if max_latency_ms is None or call.latency_ms > max_latency_ms:
                max_latency_ms = call.latency_ms
                max_latency_call_id = call.id
        if call.id in errored_span_ids:
            continue
        # The normalizer only emits ints, but hand-written rows exist —
        # coerce instead of letting a stray string crash finalize.
        reasoning = (call.raw_usage or {}).get("reasoning")
        try:
            tokens = int(reasoning) if reasoning is not None else None
        except (TypeError, ValueError):
            tokens = None
        if tokens is not None:
            total_reasoning = (total_reasoning or 0) + tokens
            if max_reasoning is None or tokens > max_reasoning:
                max_reasoning = tokens
                max_reasoning_call_id = call.id
    return GenerationRollups(
        total_reasoning_tokens=total_reasoning,
        max_call_reasoning_tokens=max_reasoning,
        max_call_reasoning_call_id=max_reasoning_call_id,
        max_call_latency_ms=max_latency_ms,
        max_call_latency_call_id=max_latency_call_id,
        total_model_time_ms=model_time_ms if saw_latency else None,
    )


def apply_generation_rollups(
    task_run: AgentTaskRunDB, rollups: GenerationRollups
) -> None:
    """Write the rollups onto the task run. Touches ONLY the issue #309
    columns — callers that also recompute cost/tokens do that themselves."""
    task_run.total_reasoning_tokens = rollups.total_reasoning_tokens
    task_run.max_call_reasoning_tokens = rollups.max_call_reasoning_tokens
    task_run.max_call_reasoning_call_id = rollups.max_call_reasoning_call_id
    task_run.max_call_latency_ms = rollups.max_call_latency_ms
    task_run.max_call_latency_call_id = rollups.max_call_latency_call_id
    task_run.total_model_time_ms = rollups.total_model_time_ms


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------


class TraceBackend(Protocol):
    """Where a task run's trace lives and how its completion data is read.

    Implementations own the trace-storage side effects (confirming a trace is
    present, linking it back to the task run, backfilling trace-level I/O) and
    the cost/token roll-up. They mutate ``task_run`` bookkeeping fields in
    place: ``trace_persistence_status``/``trace_error_message`` for
    :meth:`confirm_and_link` and ``total_cost``/``total_tokens`` plus the
    reasoning/timing rollups for :meth:`aggregate_costs`.
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
        """Sum usage, cost, and per-call timing extremes across the trace.

        ``project`` scopes the observation set so a cross-project trace id
        collision cannot inflate another run's totals.

        Sets ``task_run.total_cost`` / ``total_tokens``, the bounded
        Generation Execution Summary, and the reasoning/timing rollups
        (issue #309): ``total_reasoning_tokens`` /
        ``max_call_reasoning_tokens`` + ``max_call_reasoning_call_id``,
        ``max_call_latency_ms`` + ``max_call_latency_call_id``, and
        ``total_model_time_ms``. Errored generations are excluded from
        usage totals, which consumers must present as partial. Timing
        rollups deliberately keep errored calls — a generation that failed
        after four minutes still spent four minutes in the model, and
        "slowest call" is exactly where that surfaces. Reasoning totals
        stay null when no call reported the ``reasoning`` usage dimension
        (unknown, not zero). The reasoning/timing rollups are restricted
        to ``GENERATION`` observations: ``logged_calls`` also holds
        TOOL/structural rows, and the agent-task root span's latency is
        the whole run's wall clock — counting those would double-count
        the run and let a tool win "slowest call". Usage totals stay over
        all observations because costed spans can project as plain SPANs
        (issue #41). No-op when the task run has no trace.
        """
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
        generation_execution, errored_span_ids = generation_execution_facts(calls, spans)
        task_run.generation_execution_json = generation_execution
        # Both #309 storages stay populated: the v46 JSON summary and the
        # v47 discrete rollup columns (readers may use either).
        task_run.generation_usage_json = _generation_usage(calls, errored_span_ids)
        apply_generation_rollups(
            task_run, compute_generation_rollups(calls, errored_span_ids)
        )
        total_cost = 0.0
        total_tokens = 0
        unpriced_count = 0
        for call in calls:
            # A provider error often omits the final streamed usage event and
            # therefore projects as a plausible zero. Exclude the observation
            # from usage totals instead of treating that zero as a complete
            # measurement.
            if call.id in errored_span_ids:
                continue
            # Usage rollups stay over ALL observations, not just GENERATION:
            # issue #41 lands costed spans that project as plain SPANs
            # (e.g. ``agent-llm-call`` without gen_ai attrs) after finalize,
            # and they must still refresh the totals.
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


def generation_execution_facts(
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


def _generation_usage(
    calls: Sequence[LoggedCallDB], errored_span_ids: set[str]
) -> dict[str, object] | None:
    """Roll model time and reasoning up from the run's generations.

    An average hides the one long call a change introduced, so the summary
    keeps the slowest and the most-reasoning call alongside the totals, with
    their ids so a reader can open that call.
    """
    generations = [c for c in calls if c.observation_type == "GENERATION"]
    if not generations:
        return None

    timed = [c for c in generations if c.latency_ms is not None]
    slowest = max(timed, key=lambda c: c.latency_ms or 0.0, default=None)

    reasoning: list[tuple[LoggedCallDB, int]] = []
    for call in generations:
        if call.id in errored_span_ids:
            continue
        value = (call.raw_usage or {}).get("reasoning")
        if isinstance(value, int) and not isinstance(value, bool):
            reasoning.append((call, value))
    most = max(reasoning, key=lambda pair: pair[1], default=None)

    return {
        "generations": len(generations),
        "model_time_ms": (
            round(sum(c.latency_ms or 0.0 for c in timed), 3) if timed else None
        ),
        "slowest_call_ms": slowest.latency_ms if slowest else None,
        "slowest_call_id": slowest.id if slowest else None,
        "reasoning_tokens": sum(v for _, v in reasoning) if reasoning else None,
        "reasoning_calls": len(reasoning),
        "max_call_reasoning_tokens": most[1] if most else None,
        "max_reasoning_call_id": most[0].id if most else None,
    }


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
    (e.g. a per-project external trace source) is selected here — the task
    runner and trace UI never branch on the source themselves.
    """
    return _NATIVE
