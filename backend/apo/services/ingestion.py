"""
Shared ingestion processing service.

Contains the core processing logic for creating/updating runs, calls,
and scores. Used by all ingestion routes (batch, Langfuse, OTel).
"""

from datetime import datetime, timezone
from typing import cast

from sqlmodel import Session, select

from ..db_helpers import _ensure_utc_datetime
from ..ingestion_helpers import (
    _get_json_map,
    _get_optional_float,
    _get_optional_int,
    _get_optional_json_map,
    _get_optional_str,
    _get_str,
    _get_string_list,
)
from ..models.db import LoggedCallDB, RunDB
from ..models.schemas import MessageList
from ..services.cost_calculation import calculate_cost_for_model
from ..services.scoring import (
    create_observation_score,
    create_trace_score,
    record_score,
)
from ..services.trace_broadcaster import get_trace_broadcaster


def parse_optional_iso(dt: object) -> datetime | None:
    """Parse optional ISO datetime string to datetime object."""
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return _ensure_utc_datetime(dt)
    if isinstance(dt, str):
        return _ensure_utc_datetime(datetime.fromisoformat(dt.replace("Z", "+00:00")))
    return None


def require_str(value: object, field_name: str) -> str:
    """Require a non-empty string value, raising ValueError if missing."""
    if isinstance(value, str) and value:
        return value
    raise ValueError(f"Missing or invalid '{field_name}'")


def _get_message_list(body: dict[str, object], key: str) -> MessageList:
    value = body.get(key)
    if not isinstance(value, list):
        return []

    messages: MessageList = []
    for item in cast(list[object], value):
        if isinstance(item, dict):
            messages.append(dict(cast(dict[str, object], item)))
    return messages


async def process_call_create(body: dict[str, object], session: Session) -> None:
    """Process a call-create event."""
    call_id = body.get("id")
    if not call_id:
        raise ValueError("call-create event missing 'id'")

    created_at = parse_optional_iso(body.get("created_at")) or datetime.now(
        timezone.utc
    )
    completion_start_time = parse_optional_iso(body.get("completion_start_time"))
    end_time = parse_optional_iso(body.get("end_time"))

    prompt_tokens = _get_optional_int(body, "prompt_tokens")
    completion_tokens = _get_optional_int(body, "completion_tokens")
    total_tokens = None
    if prompt_tokens is not None and completion_tokens is not None:
        total_tokens = prompt_tokens + completion_tokens

    time_to_first_token_ms = None
    if completion_start_time and created_at:
        delta = _ensure_utc_datetime(completion_start_time) - _ensure_utc_datetime(
            created_at
        )
        time_to_first_token_ms = delta.total_seconds() * 1000

    model_name = _get_str(body, "model", "unknown")
    raw_latency_ms = _get_optional_float(body, "latency_ms")

    # SPEC-122 / trace-quality fix: SDK clients (and especially the
    # agent-task SDK) historically sent ``latency_ms: 0`` for any span
    # that completed within the same millisecond tick. The SDK uses
    # ``Date.now()`` (ms resolution) so sub-ms operations round to 0.
    # When the client also sent ``end_time`` and we have ``created_at``,
    # derive the latency from the timestamps instead — they're captured
    # independently of the latency calculation and are not subject to
    # the same rounding. Falls back to the raw value (which may be 0 or
    # None) when timestamps are unavailable.
    latency_ms = raw_latency_ms
    if raw_latency_ms is None and end_time is not None:
        latency_ms = (
            _ensure_utc_datetime(end_time) - _ensure_utc_datetime(created_at)
        ).total_seconds() * 1000

    call = LoggedCallDB(
        id=require_str(call_id, "id"),
        project=_get_str(body, "project", "default"),
        task_id=_get_str(body, "task_id", ""),
        run_id=_get_optional_str(body, "run_id"),
        flow_name=_get_optional_str(body, "flow_name"),
        step_name=_get_optional_str(body, "step_name"),
        step_index=_get_optional_int(body, "step_index"),
        version=_get_optional_str(body, "version"),
        created_at=created_at,
        model=model_name,
        latency_ms=latency_ms,
        cost=_get_optional_float(body, "cost"),
        parent_call_id=_get_optional_str(body, "parent_call_id"),
        observation_type=_get_str(body, "observation_type", "GENERATION"),
        level=_get_str(body, "level", "DEFAULT"),
        status_message=_get_optional_str(body, "status_message"),
        completion_start_time=completion_start_time,
        end_time=end_time,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        session_id=_get_optional_str(body, "session_id"),
        environment=_get_str(body, "environment", "default"),
        tags=_get_string_list(body, "tags"),
        total_tokens=total_tokens,
        prompt_id=_get_optional_str(body, "prompt_id"),
        prompt_version=_get_optional_int(body, "prompt_version"),
        provided_cost=_get_optional_float(body, "provided_cost"),
        calculated_cost=_get_optional_float(body, "calculated_cost"),
        time_to_first_token_ms=time_to_first_token_ms,
        provided_model_name=_get_optional_str(body, "provided_model_name"),
        internal_model_id=_get_optional_str(body, "internal_model_id"),
        tool_name=_get_optional_str(body, "tool_name"),
        tool_parameters=_get_optional_json_map(body, "tool_parameters"),
        tool_result=_get_optional_json_map(body, "tool_result"),
        input=_get_json_map(body, "input"),
        messages=_get_message_list(body, "messages"),
        output=_get_json_map(body, "output"),
        user_id=_get_optional_str(body, "user_id"),
        meta=_get_optional_json_map(body, "metadata"),
    )

    if prompt_tokens is not None and completion_tokens is not None:
        calculated = calculate_cost_for_model(
            session, model_name, prompt_tokens, completion_tokens
        )
        if calculated is not None:
            call.calculated_cost = calculated

    _ = session.merge(call)
    session.commit()

    run_id = _get_optional_str(body, "run_id")
    if run_id:
        try:
            broadcaster = await get_trace_broadcaster()
            await broadcaster.broadcast_span_created(run_id, body)
        except Exception:
            pass


async def process_call_update(body: dict[str, object], session: Session) -> None:
    """Process a call-update event (e.g., add output after LLM completes)."""
    call_id = body.get("id")
    if not call_id:
        raise ValueError("call-update event missing 'id'")

    project = _get_optional_str(body, "project") or "default"
    call = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.id == call_id, LoggedCallDB.project == project
        )
    ).first()
    if not call:
        raise ValueError(f"LoggedCall not found: {call_id}")

    if "output" in body:
        call.output = _get_json_map(body, "output")
    if "latency_ms" in body:
        call.latency_ms = _get_optional_float(body, "latency_ms")
    if "end_time" in body:
        call.end_time = parse_optional_iso(body["end_time"])
    # SPEC-122 / trace-quality fix: after applying the SDK-supplied
    # ``latency_ms`` and ``end_time`` above, re-derive latency from
    # timestamps when the SDK omitted it. This catches both:
    #   - SDK sent ``latency_ms: null`` with ``end_time``
    #   - SDK sent only ``end_time`` (no ``latency_ms`` key at all)
    # The common case is the agent-task SDK finalising a span with
    # ``call-update`` that carries ``end_time`` but no explicit latency.
    if call.latency_ms is None and call.end_time is not None and call.created_at is not None:
        call.latency_ms = (
            _ensure_utc_datetime(call.end_time)
            - _ensure_utc_datetime(call.created_at)
        ).total_seconds() * 1000
    if "prompt_tokens" in body:
        call.prompt_tokens = _get_optional_int(body, "prompt_tokens")
    if "completion_tokens" in body:
        call.completion_tokens = _get_optional_int(body, "completion_tokens")
    if "cost" in body:
        call.cost = _get_optional_float(body, "cost")
    if "status_message" in body:
        call.status_message = _get_optional_str(body, "status_message")
    if "level" in body:
        call.level = _get_str(body, "level", call.level)
    if "meta" in body:
        call.meta = _get_optional_json_map(body, "meta")

    if "completion_start_time" in body:
        call.completion_start_time = parse_optional_iso(body["completion_start_time"])
    if "total_tokens" in body:
        call.total_tokens = _get_optional_int(body, "total_tokens")
    elif "prompt_tokens" in body or "completion_tokens" in body:
        if call.prompt_tokens is not None and call.completion_tokens is not None:
            call.total_tokens = call.prompt_tokens + call.completion_tokens
    if "prompt_id" in body:
        call.prompt_id = _get_optional_str(body, "prompt_id")
    if "prompt_version" in body:
        call.prompt_version = _get_optional_int(body, "prompt_version")
    if "provided_cost" in body:
        call.provided_cost = _get_optional_float(body, "provided_cost")
    if "calculated_cost" in body:
        call.calculated_cost = _get_optional_float(body, "calculated_cost")
    if "time_to_first_token_ms" in body:
        call.time_to_first_token_ms = _get_optional_float(
            body, "time_to_first_token_ms"
        )
    elif "completion_start_time" in body and call.created_at:
        if call.completion_start_time:
            delta = _ensure_utc_datetime(
                call.completion_start_time
            ) - _ensure_utc_datetime(call.created_at)
            call.time_to_first_token_ms = delta.total_seconds() * 1000
    if "provided_model_name" in body:
        call.provided_model_name = _get_optional_str(body, "provided_model_name")
    if "internal_model_id" in body:
        call.internal_model_id = _get_optional_str(body, "internal_model_id")
    if "tool_name" in body:
        call.tool_name = _get_optional_str(body, "tool_name")
    if "tool_parameters" in body:
        call.tool_parameters = _get_optional_json_map(body, "tool_parameters")
    if "tool_result" in body:
        call.tool_result = _get_optional_json_map(body, "tool_result")
    if "session_id" in body:
        call.session_id = _get_optional_str(body, "session_id")
    if "environment" in body:
        call.environment = _get_str(body, "environment", call.environment)
    if "tags" in body:
        call.tags = _get_string_list(body, "tags")

    if call.prompt_tokens is not None and call.completion_tokens is not None:
        calculated = calculate_cost_for_model(
            session, call.model, call.prompt_tokens, call.completion_tokens
        )
        if calculated is not None:
            call.calculated_cost = calculated

    session.commit()

    if call.run_id:
        try:
            broadcaster = await get_trace_broadcaster()
            await broadcaster.broadcast_span_updated(call.run_id, {"id": call_id, **body})
        except Exception:
            pass


async def process_score_create(body: dict[str, object], session: Session) -> None:
    """Process a score-create event (internal snake_case format)."""
    trace_id = _get_optional_str(body, "trace_id")
    observation_id = _get_optional_str(body, "observation_id")
    name = _get_optional_str(body, "name")

    if not name:
        raise ValueError("score-create event missing 'name'")

    value_raw = body.get("value")
    if value_raw is None:
        raise ValueError("score-create event missing 'value'")

    if isinstance(value_raw, (int, float)):
        value: float | str | bool = float(value_raw)
    elif isinstance(value_raw, bool):
        value = value_raw
    elif isinstance(value_raw, str):
        value = value_raw
    else:
        value = float(str(value_raw))

    data_type = _get_str(body, "data_type", "NUMERIC")
    source = _get_str(body, "source", "API")
    config_id = _get_optional_int(body, "config_id")
    comment = _get_optional_str(body, "comment")

    if observation_id:
        _ = create_observation_score(
            session=session,
            observation_id=observation_id,
            name=name,
            value=value,
            data_type=data_type,
            source=source,
            config_id=config_id,
            comment=comment,
        )
    elif trace_id:
        _ = create_trace_score(
            session=session,
            trace_id=trace_id,
            name=name,
            value=value,
            data_type=data_type,
            source=source,
            config_id=config_id,
            comment=comment,
        )
    else:
        raise ValueError("score-create event requires trace_id or observation_id")


async def process_langfuse_score_create(
    body: dict[str, object], session: Session, project: str = "default"
) -> None:
    """Process a score-create event from Langfuse SDK (camelCase fields).

    ``project`` comes from the route's authenticated API key, never from the
    body, so a caller cannot score another project's trace (SPEC-133 M4).
    """
    trace_id = _get_optional_str(body, "traceId")
    observation_id = _get_optional_str(body, "observationId")

    if trace_id:
        run = session.exec(
            select(RunDB).where(RunDB.id == trace_id, RunDB.project == project)
        ).first()
        if not run:
            raise ValueError(f"Trace not found: {trace_id}")
        target: tuple[str, str] = ("trace", trace_id)
    elif observation_id:
        call = session.exec(
            select(LoggedCallDB).where(
                LoggedCallDB.id == observation_id, LoggedCallDB.project == project
            )
        ).first()
        if not call:
            raise ValueError(f"Observation not found: {observation_id}")
        target = ("observation", observation_id)
    else:
        raise ValueError("score-create requires traceId or observationId")

    value_raw = body.get("value")
    if isinstance(value_raw, (int, float)):
        value: float | str | bool | None = float(value_raw)
    elif isinstance(value_raw, bool):
        value = value_raw
    elif isinstance(value_raw, str):
        value = value_raw
    else:
        value = value_raw if value_raw is None else float(str(value_raw))

    _ = record_score(
        session=session,
        target=target,
        name=_get_str(body, "name", "unnamed"),
        value=value,
        data_type=_get_str(body, "dataType", "NUMERIC"),
        source=_get_str(body, "source", "API"),
        config_id=_get_optional_int(body, "configId"),
        comment=_get_optional_str(body, "comment"),
        project=project,
    )
