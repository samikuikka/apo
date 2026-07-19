# pyright: reportExplicitAny=false

"""Trace Projection repository (SPEC-130 Track A).

Reads the physical Trace Projection tables (``RunDB`` / ``LoggedCallDB``,
supplied by SPEC-129's projector) and returns an immutable
``TraceProjectionSnapshot`` — never SQLModel rows. This is the read boundary
the Task-Run-scoped projection endpoint (Track B) and the agent-task runner
(Track C) consume.

Properties:
  - Project isolation on every lookup: a trace_id without the authenticated
    Project ID is insufficient (returns ``None``).
  - Callers never receive ``RunDB``/``LoggedCallDB`` instances. Changing the
    physical projection storage later must not change this interface.
  - Capabilities are derived honestly from what the projected rows carry; the
    repository never invents timing, errors, or status that the source lacks.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Protocol, cast

from sqlmodel import Session, col, func, select

from ..models.db import LoggedCallDB, OtlpSpanDB, RunDB
from ..models.trace_projection import (
    EvidenceAvailability,
    ObservationStatus,
    TraceProjectionCapabilities,
    TraceProjectionMessage,
    TraceProjectionObservation,
    TraceProjectionSnapshot,
    TraceProjectionTrace,
)


class TraceRepository(Protocol):
    """Read/write boundary for an immutable Trace Projection snapshot.

    Per SPEC-129 §4: "introduce a ``TraceRepository`` as the only read/write
    boundary for product Trace Projections." Both the projector (writes) and
    the dashboard/CLI (reads) go through this interface.
    """

    def get_projection_snapshot(
        self,
        session: Session,
        *,
        project_id: str,
        trace_id: str,
    ) -> TraceProjectionSnapshot | None:
        """Return the projection snapshot for ``trace_id`` in ``project_id``.

        Returns ``None`` when the trace does not exist in that Project. Enforces
        Project isolation: the caller-supplied trace_id alone is never trusted
        across Projects.
        """
        ...

    def upsert_trace(
        self,
        session: Session,
        *,
        trace_id: str,
        project_id: str,
        flow_name: str | None = None,
        task_id: str | None = None,
        version: str | None = None,
        environment: str = "default",
        created_at: datetime | None = None,
    ) -> RunDB:
        """Upsert a Trace (RunDB). Returns the run row.

        This is the write boundary — callers never construct RunDB directly.
        """
        ...

    def upsert_observation(
        self,
        session: Session,
        *,
        span_id: str,
        trace_id: str,
        project_id: str,
        observation_type: str = "SPAN",
        model: str = "",
        step_name: str = "",
        parent_call_id: str | None = None,
        input: dict[str, Any] | None = None,
        output: dict[str, Any] | None = None,
        messages: list[dict[str, Any]] | None = None,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        latency_ms: float | None = None,
        level: str = "DEFAULT",
        status_message: str | None = None,
        tool_name: str | None = None,
        tool_parameters: dict[str, Any] | None = None,
        tool_result: dict[str, Any] | None = None,
        created_at: datetime | None = None,
        end_time: datetime | None = None,
    ) -> LoggedCallDB:
        """Upsert an Observation (LoggedCallDB). Returns the call row.

        This is the write boundary — callers never construct LoggedCallDB directly.
        """
        ...

    def complete_trace(
        self,
        session: Session,
        *,
        trace_id: str,
        project_id: str,
        duration_ms: float | None = None,
    ) -> None:
        """Mark a Trace as complete, setting completed_at and duration_ms."""
        ...


# ---------------------------------------------------------------------------
# Native implementation (reads SPEC-129's projected runs/logged_calls)
# ---------------------------------------------------------------------------


def _to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _status_for(call: LoggedCallDB) -> ObservationStatus:
    if call.level == "ERROR":
        return ObservationStatus.ERROR
    if call.latency_ms is not None or call.end_time is not None:
        return ObservationStatus.OK
    return ObservationStatus.UNSET


def _messages_for(call: LoggedCallDB) -> tuple[TraceProjectionMessage, ...]:
    """Reconstruct chat messages from a generation call's recorded output.

    Only generation calls that recorded a text-like output produce a message;
    we never fabricate messages from spans that carried none.
    """
    if call.observation_type != "GENERATION":
        return ()
    raw = call.output.get("text") if call.output else None
    if not isinstance(raw, str) or raw == "":
        return ()
    return (TraceProjectionMessage(role="assistant", content=raw),)


_OBSERVATION_TYPES = frozenset({
    "SPAN", "GENERATION", "TOOL", "AGENT", "SKILL", "CHAIN",
    "RETRIEVER", "EMBEDDING", "GUARDRAIL",
})

# The closed Literal set of observation types the projection exposes.
_ObservationTypeLit = Literal[
    "SPAN", "GENERATION", "TOOL", "AGENT", "SKILL", "CHAIN",
    "RETRIEVER", "EMBEDDING", "GUARDRAIL",
]


def _build_observation(call: LoggedCallDB) -> TraceProjectionObservation:
    # Narrow the free-form DB string to the projection's closed Literal set;
    # anything unrecognized survives as SPAN (SPEC-130: unknown spans survive).
    raw_type = call.observation_type
    narrowed = raw_type if raw_type in _OBSERVATION_TYPES else "SPAN"
    typed_type = cast(_ObservationTypeLit, narrowed)

    started_at = _to_iso(call.completion_start_time) or _to_iso(call.created_at)
    ended_at = _to_iso(call.end_time)

    duration_ms = call.latency_ms
    if duration_ms is None and call.completion_start_time and call.end_time:
        duration_ms = (
            call.end_time.replace(tzinfo=None) - call.completion_start_time.replace(tzinfo=None)
        ).total_seconds() * 1000

    obs = TraceProjectionObservation(
        span_id=call.id,
        parent_span_id=call.parent_call_id,
        type=typed_type,
        name=call.step_name or call.tool_name or typed_type.lower(),
        started_at=started_at,
        ended_at=ended_at,
        duration_ms=duration_ms,
        status=_status_for(call),
        error_message=call.status_message if call.level == "ERROR" else None,
        model=call.model if call.model and call.model != "unknown" else None,
        input=call.input or None,
        output=call.output or None,
        tool_name=call.tool_name,
        tool_parameters=call.tool_parameters,
        tool_result=call.tool_result,
        messages=_messages_for(call),
    )
    return obs


def _derive_capabilities(
    calls: list[LoggedCallDB],
    run: RunDB,
) -> TraceProjectionCapabilities:
    types = {c.observation_type for c in calls}
    has_messages = any(_messages_for(c) for c in calls)
    has_timing = run.duration_ms is not None or any(
        c.latency_ms is not None or c.end_time is not None for c in calls
    )
    # `errors` is available whenever the trace has any observations: a complete
    # trace with no ERROR-level calls IS proof that no actions failed. Matching
    # the in-process tee's semantics (projection-tee.ts) so the same eval
    # assertion (noFailedActions) behaves identically on both read paths.
    return TraceProjectionCapabilities(
        messages=EvidenceAvailability.AVAILABLE if has_messages else EvidenceAvailability.UNAVAILABLE,
        tools=EvidenceAvailability.AVAILABLE if "TOOL" in types else EvidenceAvailability.UNAVAILABLE,
        errors=EvidenceAvailability.AVAILABLE if calls else EvidenceAvailability.UNAVAILABLE,
        timing=EvidenceAvailability.AVAILABLE if has_timing else EvidenceAvailability.UNAVAILABLE,
        skills=EvidenceAvailability.AVAILABLE if "SKILL" in types else EvidenceAvailability.UNAVAILABLE,
        subagents=EvidenceAvailability.AVAILABLE if "AGENT" in types else EvidenceAvailability.UNAVAILABLE,
    )


class NativeTraceRepository:
    """Reads the projected ``runs``/``logged_calls`` tables.

    Callers receive only :class:`TraceProjectionSnapshot` instances. The
    physical tables are an implementation detail of the SPEC-129 projector; if
    storage changes later this class (not its callers) is the only thing that
    moves.
    """

    def get_projection_snapshot(
        self,
        session: Session,
        *,
        project_id: str,
        trace_id: str,
    ) -> TraceProjectionSnapshot | None:
        # Project isolation: look up the run scoped by BOTH id and project.
        run = session.exec(
            select(RunDB).where(
                col(RunDB.id) == trace_id,
                col(RunDB.project) == project_id,
            )
        ).first()
        if run is None:
            return None

        calls = session.exec(
            select(LoggedCallDB)
            .where(
                col(LoggedCallDB.run_id) == trace_id,
                col(LoggedCallDB.project) == project_id,
            )
            .order_by(col(LoggedCallDB.created_at))
        ).all()

        observations = tuple(_build_observation(c) for c in calls)

        # Projection version: the max version stamped on the trace's canonical
        # OTel spans (SPEC-129). Falls back to 0 when no canonical spans exist.
        projection_version = session.exec(
            select(func.max(OtlpSpanDB.projection_version)).where(
                col(OtlpSpanDB.trace_id) == trace_id,
                col(OtlpSpanDB.project_id) == project_id,
            )
        ).one_or_none()
        if projection_version is None:
            projection_version = 0

        trace = TraceProjectionTrace(
            trace_id=run.id,
            task_run_id=run.task_run_id,
            name=run.flow_name,
            started_at=_to_iso(run.created_at),
            ended_at=_to_iso(run.completed_at),
            duration_ms=run.duration_ms,
            complete=run.completed_at is not None,
        )

        return TraceProjectionSnapshot(
            projection_version=projection_version,
            source="canonical",
            trace=trace,
            capabilities=_derive_capabilities(list(calls), run),
            observations=observations,
        )


    # ── Write boundary (SPEC-129 §4) ────────────────────────────────────

    def upsert_trace(
        self,
        session: Session,
        *,
        trace_id: str,
        project_id: str,
        flow_name: str | None = None,
        task_id: str | None = None,
        version: str | None = None,
        environment: str = "default",
        created_at: datetime | None = None,
    ) -> RunDB:
        """Upsert a Trace (RunDB). Idempotent within one Project."""
        from datetime import timezone as _tz

        run = session.exec(
            select(RunDB).where(
                col(RunDB.id) == trace_id,
                col(RunDB.project) == project_id,
            )
        ).first()
        if run is None:
            run = RunDB(
                id=trace_id,
                project=project_id,
                environment=environment,
                created_at=created_at or datetime.now(_tz.utc),
            )
            if flow_name:
                run.flow_name = flow_name
            if task_id:
                run.task_id = task_id
            if version:
                run.version = version
            session.add(run)
            session.flush()
        else:
            if flow_name is not None:
                run.flow_name = flow_name
            if task_id is not None:
                run.task_id = task_id
            if version is not None:
                run.version = version
            session.add(run)
            session.flush()
        return run

    def upsert_observation(
        self,
        session: Session,
        *,
        span_id: str,
        trace_id: str,
        project_id: str,
        observation_type: str = "SPAN",
        model: str = "",
        step_name: str = "",
        parent_call_id: str | None = None,
        input: dict[str, Any] | None = None,
        output: dict[str, Any] | None = None,
        messages: list[dict[str, Any]] | None = None,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        latency_ms: float | None = None,
        level: str = "DEFAULT",
        status_message: str | None = None,
        tool_name: str | None = None,
        tool_parameters: dict[str, Any] | None = None,
        tool_result: dict[str, Any] | None = None,
        created_at: datetime | None = None,
        end_time: datetime | None = None,
    ) -> LoggedCallDB:
        """Upsert an Observation (LoggedCallDB). Idempotent within one Project."""
        call = session.exec(
            select(LoggedCallDB).where(
                col(LoggedCallDB.id) == span_id,
                col(LoggedCallDB.project) == project_id,
            )
        ).first()
        if call is None:
            call = LoggedCallDB(
                id=span_id,
                run_id=trace_id,
                project=project_id,
                task_id="",
                created_at=created_at or datetime.now(timezone.utc),
                model=model,
                observation_type=observation_type,
                step_name=step_name,
                parent_call_id=parent_call_id,
                input=input or {},
                output=output or {},
                messages=messages or [],
            )
            session.add(call)
            session.flush()
        else:
            call.observation_type = observation_type
            if model:
                call.model = model
            if step_name:
                call.step_name = step_name
            call.parent_call_id = parent_call_id
            if input is not None:
                call.input = input
            if output is not None:
                call.output = output
            if messages is not None:
                call.messages = messages  # type: ignore[assignment]
            session.add(call)
            session.flush()

        # Set typed fields
        if prompt_tokens is not None:
            call.prompt_tokens = prompt_tokens
        if completion_tokens is not None:
            call.completion_tokens = completion_tokens
        if latency_ms is not None:
            call.latency_ms = latency_ms
        if level != "DEFAULT":
            call.level = level
        if status_message:
            call.status_message = status_message
        if tool_name:
            call.tool_name = tool_name
        if tool_parameters is not None:
            call.tool_parameters = tool_parameters
        if tool_result is not None:
            call.tool_result = tool_result
        if end_time:
            call.end_time = end_time

        session.add(call)
        session.flush()
        return call

    def complete_trace(
        self,
        session: Session,
        *,
        trace_id: str,
        project_id: str,
        duration_ms: float | None = None,
    ) -> None:
        """Mark a Trace as complete."""
        run = session.exec(
            select(RunDB).where(
                col(RunDB.id) == trace_id,
                col(RunDB.project) == project_id,
            )
        ).first()
        if run is None or run.completed_at is not None:
            return
        run.completed_at = datetime.now(timezone.utc)
        if duration_ms is not None:
            run.duration_ms = duration_ms
        session.add(run)
        session.flush()


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

_NATIVE = NativeTraceRepository()


def get_trace_repository(_project: str | None = None) -> TraceRepository:
    """Return the active trace repository.

    Currently only the native repository exists. A future external backend is
    selected here — consumers never branch on the source themselves.
    """
    return _NATIVE
